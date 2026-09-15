import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetricsService } from '../common/metrics/metrics.service';
import { PrismaService } from '../database/prisma.service';
import { AiLlmClientService } from './ai-llm-client.service';
import { AiSchoolInsightsService } from './ai-school-insights.service';
import { isDocumentKnowledgeChunk } from './knowledge-chunk-types';

/**
 * Embeddings + vector context retrieval for Lois (knowledge chunks).
 */
@Injectable()
export class AiContextRagService {
  private readonly logger = new Logger(AiContextRagService.name);

  constructor(
    private readonly llm: AiLlmClientService,
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly metricsService: MetricsService,
    private readonly schoolInsights: AiSchoolInsightsService,
  ) {}

  async createEmbedding(text: string): Promise<number[]> {
    this.llm.ensureConfigured();
    const embeddingsClient = this.llm.getEmbeddingsClient();

    const startTime = Date.now();
    try {
      const modelName = this.llm.getEmbeddingsModel();

      const response = await embeddingsClient.embeddings.create({
        model: modelName,
        input: text.substring(0, 8192),
      });
      const durationMs = Date.now() - startTime;
      this.metricsService.recordLoisDuration(durationMs, { operation: 'create_embedding' });
      this.metricsService.loisApiCallsTotal.inc({ operation: 'create_embedding', status: 'success' });
      return response.data[0].embedding;
    } catch (error) {
      this.metricsService.loisApiCallsTotal.inc({ operation: 'create_embedding', status: 'failed' });
      this.metricsService.loisErrorsTotal.inc({ error_type: 'embedding_failed' });
      this.logger.error(`Embedding failed: ${error}`);
      throw new BadRequestException('Failed to process context for search');
    }
  }

  async findRelevantContext(
    query: string,
    schoolId: string,
    role: string,
    limit: number = 5,
    options?: { userId?: string },
  ): Promise<{ text: string; sources: { type: string; relevance: number }[] }> {
    try {
      const embedding = await this.createEmbedding(query);
      const vectorString = `[${embedding.join(',')}]`;

      const fetchLimit =
        role === 'TEACHER' && options?.userId ? Math.min(120, Math.max(limit * 20, 40)) : limit;

      const chunks: any[] = await this.prisma.$queryRawUnsafe(
        `
        SELECT content, metadata, (embedding <=> $3::vector) as distance
        FROM "KnowledgeChunk"
        WHERE "schoolId" = $1
        AND embedding IS NOT NULL
        AND (
          (metadata->'permissions'->'roles')::jsonb ? $2
          OR (metadata->'permissions'->'isPublic')::boolean = true
        )
        AND (
          lower(coalesce(metadata->>'type', '')) IN ('policy', 'handbook', 'document')
          OR lower(coalesce(metadata->>'source', '')) = 'upload'
        )
        ORDER BY embedding <=> $3::vector
        LIMIT $4
      `,
        schoolId,
        role,
        vectorString,
        fetchLimit,
      );

      if (!chunks || chunks.length === 0) {
        return { text: '', sources: [] };
      }

      const parseMeta = (raw: unknown) =>
        typeof raw === 'string' ? JSON.parse(raw) : raw;

      let relevantChunks = chunks.filter((c) => {
        if (c.distance >= 0.85) return false;
        try {
          return isDocumentKnowledgeChunk(parseMeta(c.metadata));
        } catch {
          return false;
        }
      });

      if (role === 'TEACHER' && options?.userId) {
        const access = await this.schoolInsights.resolveTeacherRagAccess(options.userId, schoolId);
        if (access) {
          relevantChunks = relevantChunks.filter((c) => {
            const meta = typeof c.metadata === 'string' ? JSON.parse(c.metadata) : c.metadata;
            return this.schoolInsights.chunkVisibleToTeacher(meta, access);
          });
        }
      }

      relevantChunks = relevantChunks.slice(0, limit);

      if (relevantChunks.length === 0) {
        return { text: '', sources: [] };
      }

      const sources = relevantChunks.map((c) => {
        const meta = typeof c.metadata === 'string' ? JSON.parse(c.metadata) : c.metadata;
        return {
          type: meta?.type || 'document',
          relevance: Math.round((1 - c.distance) * 100),
        };
      });

      const contextParts = relevantChunks.map((c, i) => {
        const meta = typeof c.metadata === 'string' ? JSON.parse(c.metadata) : c.metadata;
        const title = meta?.title ? ` — ${meta.title}` : '';
        const sourceLabel =
          meta?.type === 'handbook'
            ? 'Handbook'
            : meta?.type === 'document'
              ? 'School document'
              : 'School policy';
        return `[Source ${i + 1}: ${sourceLabel}${title} — ${sources[i].relevance}% relevance]\n${c.content}`;
      });

      return {
        text: contextParts.join('\n\n---\n\n'),
        sources,
      };
    } catch (error) {
      this.logger.error(`Context retrieval failed: ${error}`);
      return { text: '', sources: [] };
    }
  }
}
