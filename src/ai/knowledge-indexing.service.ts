import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../database/prisma.service';
import { VECTOR_QUEUE_NAME, JOB_GENERATE_EMBEDDING } from './vector.processor';
import { isDocumentKnowledgeChunk } from './knowledge-chunk-types';

@Injectable()
export class KnowledgeIndexingService implements OnModuleInit {
  private readonly logger = new Logger(KnowledgeIndexingService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(VECTOR_QUEUE_NAME) private readonly vectorQueue: Queue,
  ) {}

  async onModuleInit() {
    this.logger.log('Knowledge Indexing Service initialized (document embeddings only)');
  }

  /**
   * Safety net: re-embed handbook/policy chunks that never got a vector.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async handleNightlySync() {
    this.logger.log('[Safety Net] Re-embedding knowledge documents with missing vectors...');
    const rows = await this.prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM "KnowledgeChunk"
       WHERE embedding IS NULL
         AND content IS NOT NULL
         AND trim(content) != ''
         AND (
           lower(coalesce(metadata->>'type', '')) IN ('policy', 'handbook', 'document')
           OR lower(coalesce(metadata->>'source', '')) = 'upload'
         )`,
    );
    for (const row of rows) {
      await this.queueDocumentEmbedding(row.id);
    }
    this.logger.log(`[Safety Net] Queued ${rows.length} document embedding job(s).`);
  }

  /** Operational entity indexing is retired. Documents are queued on upload. */
  async triggerEntitySync(_type?: string, _id?: string) {
    return;
  }

  async queueDocumentEmbedding(chunkId: string) {
    await this.vectorQueue.add(
      JOB_GENERATE_EMBEDDING,
      { chunkId },
      { priority: 10, removeOnComplete: true, removeOnFail: { count: 100 } },
    );
  }

  /**
   * Manual trigger: re-embed this school's policy/handbook chunks only.
   */
  async syncSchool(schoolId: string) {
    this.logger.log(`Manual document re-index requested for school: ${schoolId}`);
    const chunks = await this.prisma.knowledgeChunk.findMany({
      where: { schoolId },
      select: { id: true, metadata: true },
    });
    let queued = 0;
    for (const chunk of chunks) {
      if (!isDocumentKnowledgeChunk(chunk.metadata)) continue;
      await this.queueDocumentEmbedding(chunk.id);
      queued += 1;
    }
    return { queued };
  }
}
