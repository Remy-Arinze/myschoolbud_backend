import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import OpenAI, { AzureOpenAI } from 'openai';
import { PrismaService } from '../database/prisma.service';

/**
 * Central LLM + embeddings client.
 *
 * Chat provider priority (first configured wins):
 *   1. Standard OpenAI   — OPENAI_API_KEY
 *   2. OpenRouter        — OPENROUTER_API_KEY  (OpenAI-compatible, acts as fallback)
 *   3. Azure OpenAI      — AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_DEPLOYMENT
 *
 * Embeddings provider priority:
 *   1. Standard OpenAI   — OPENAI_API_KEY  (uses text-embedding-3-small by default)
 *   2. Azure Embeddings  — AZURE_OPENAI_EMBEDDING_API_KEY + endpoint + deployment
 *   3. Falls back to the chat client if neither is available
 *
 * Model resolution (chat):
 *   OPENAI_MODEL env var → default depends on provider:
 *     OpenAI / OpenRouter: gpt-4o-mini
 *     Azure: value from AZURE_OPENAI_DEPLOYMENT
 */
@Injectable()
export class AiLlmClientService {
  private readonly logger = new Logger(AiLlmClientService.name);

  private openai: OpenAI | null = null;
  private embeddingsClient: OpenAI | null = null;
  private readonly model: string;
  private readonly workerModel: string;
  private readonly routerModel: string;
  private readonly readOnlyPrisma: PrismaClient;

  /** Which provider is active — for log messages only. */
  private readonly chatProviderName: string = 'none';
  private readonly embeddingsProviderName: string = 'none';
  private readonly embeddingsModel: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    // ── Read-only Prisma ────────────────────────────────────────────────────
    const readOnlyUrl =
      this.configService.get<string>('READONLY_DATABASE_URL') ||
      this.configService.get<string>('DATABASE_URL') ||
      this.configService.get<string>('DB_URL');
    this.readOnlyPrisma = new PrismaClient({
      datasources: { db: { url: readOnlyUrl } },
    });

    // ── Env vars ────────────────────────────────────────────────────────────
    const openaiKey = this.configService.get<string>('OPENAI_API_KEY');
    const openrouterKey = this.configService.get<string>('OPENROUTER_API_KEY');
    const openrouterBaseUrl = this.configService.get<string>('OPENROUTER_BASE_URL') || 'https://openrouter.ai/api/v1';
    const appUrl = this.configService.get<string>('FRONTEND_URL') || 'https://myschoolbud.com';

    const azureApiKey = this.configService.get<string>('AZURE_OPENAI_API_KEY');
    const azureEndpoint = this.configService.get<string>('AZURE_OPENAI_ENDPOINT');
    const azureDeployment = this.configService.get<string>('AZURE_OPENAI_DEPLOYMENT');
    const azureApiVersion = this.configService.get<string>('AZURE_OPENAI_API_VERSION');

    const azureEmbedKey = this.configService.get<string>('AZURE_OPENAI_EMBEDDING_API_KEY');
    const azureEmbedEndpoint =
      this.configService.get<string>('Azure_OPENAI_EMBEDDING_ENDPOINT') ||
      this.configService.get<string>('AZURE_OPENAI_EMBEDDING_ENDPOINT');
    const azureEmbedDeployment = this.configService.get<string>('AZURE_OPENAI_EMBEDDING_DEPLOYMENT');
    const azureEmbedApiVersion = this.configService.get<string>('AZURE_OPENAI_EMBEDDING_API_VERSION');

    const customModel = this.configService.get<string>('OPENAI_MODEL');

    // ── Chat client — priority: OpenAI → OpenRouter → Azure ─────────────────
    if (openaiKey && openaiKey !== 'your_openai_api_key_here') {
      this.openai = new OpenAI({ apiKey: openaiKey });
      this.model = customModel || 'gpt-4o-mini';
      (this as any).chatProviderName = 'openai';
      this.logger.log(`Chat provider: Standard OpenAI (model: ${this.model})`);

    } else if (openrouterKey) {
      this.openai = new OpenAI({
        apiKey: openrouterKey,
        baseURL: openrouterBaseUrl,
        defaultHeaders: {
          'HTTP-Referer': appUrl,
          'X-Title': 'Myschoolbud Education Platform',
        },
      });
      this.model = customModel || 'openai/gpt-4o-mini';
      (this as any).chatProviderName = 'openrouter';
      this.logger.log(`Chat provider: OpenRouter (model: ${this.model})`);

    } else if (azureApiKey && azureEndpoint && azureDeployment) {
      this.openai = new AzureOpenAI({
        apiKey: azureApiKey,
        endpoint: azureEndpoint,
        apiVersion: azureApiVersion || '2025-01-01-preview',
        deployment: azureDeployment,
      }) as any;
      this.model = customModel || azureDeployment;
      (this as any).chatProviderName = 'azure';
      this.logger.log(`Chat provider: Azure OpenAI (deployment: ${azureDeployment})`);

    } else {
      this.model = customModel || 'gpt-4o-mini';
      this.logger.warn(
        'AI chat is not configured. Set OPENAI_API_KEY (preferred) or OPENROUTER_API_KEY (fallback).',
      );
    }

    this.workerModel = this.configService.get<string>('OPENAI_WORKER_MODEL') || this.model;
    this.routerModel = this.configService.get<string>('OPENAI_ROUTER_MODEL') || this.model;

    // ── Embeddings client — priority: OpenAI → Azure ─────────────────────
    if (openaiKey && openaiKey !== 'your_openai_api_key_here') {
      // Re-use the same standard OpenAI client — no extra instance needed
      this.embeddingsClient = this.openai;
      this.embeddingsModel = 'text-embedding-3-small';
      (this as any).embeddingsProviderName = 'openai';
      this.logger.log('Embeddings provider: Standard OpenAI (text-embedding-3-small)');

    } else if (azureEmbedKey && azureEmbedEndpoint && azureEmbedDeployment) {
      this.embeddingsClient = new AzureOpenAI({
        apiKey: azureEmbedKey,
        endpoint: azureEmbedEndpoint,
        apiVersion: azureEmbedApiVersion || '2023-05-15',
        deployment: azureEmbedDeployment,
      }) as any;
      this.embeddingsModel = azureEmbedDeployment;
      (this as any).embeddingsProviderName = 'azure';
      this.logger.log(`Embeddings provider: Azure OpenAI (deployment: ${azureEmbedDeployment})`);

    } else {
      // Final fallback: share the chat client (works for OpenRouter if model supports embeddings,
      // but OpenRouter doesn't — this path only gets used if nothing else is set)
      this.embeddingsClient = this.openai;
      this.embeddingsModel = 'text-embedding-3-small';
      (this as any).embeddingsProviderName = 'fallback';
      if (this.openai) {
        this.logger.warn('Embeddings: falling back to chat client — set OPENAI_API_KEY for dedicated embeddings.');
      }
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  isConfigured(): boolean {
    return this.openai !== null;
  }

  ensureConfigured(): void {
    if (!this.openai) {
      throw new BadRequestException(
        'AI features are not configured. Please contact your administrator.',
      );
    }
  }

  getOpenai(): OpenAI {
    this.ensureConfigured();
    return this.openai!;
  }

  getEmbeddingsClient(): OpenAI {
    this.ensureConfigured();
    if (!this.embeddingsClient) {
      throw new BadRequestException('Embeddings client is not configured.');
    }
    return this.embeddingsClient;
  }

  getModel(): string {
    return this.model;
  }

  /** Workers and facing. Falls back to OPENAI_MODEL. */
  getWorkerModel(): string {
    return this.workerModel;
  }

  /** Slim turn-plan classifier. Falls back to OPENAI_MODEL. */
  getRouterModel(): string {
    return this.routerModel;
  }

  /**
   * The embeddings model name to pass to `embeddings.create({ model })`.
   * Standard OpenAI: "text-embedding-3-small"
   * Azure: the deployment name (Azure ignores the model field but some callers set it)
   */
  getEmbeddingsModel(): string {
    return this.embeddingsModel;
  }

  /**
   * @deprecated AbortSignal must be passed as create()'s second argument (RequestOptions),
   * never as a chat body field. Do not use this to decide whether cancellation is supported.
   */
  chatClientRejectsAbortSignal(): boolean {
    return false;
  }

  getReadOnlyPrisma(): PrismaClient {
    return this.readOnlyPrisma;
  }

  getPrisma(): PrismaService {
    return this.prisma;
  }
}
