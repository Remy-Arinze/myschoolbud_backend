import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { loadPostgresCheckpoint, loadMemorySaver } from './langgraph-loader';

@Injectable()
export class LoisCheckpointerService implements OnModuleInit {
  private readonly logger = new Logger(LoisCheckpointerService.name);
  private checkpointer: unknown = null;
  private ready: Promise<void> | null = null;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    this.ready = this.init();
    await this.ready;
  }

  async getCheckpointer(): Promise<unknown> {
    if (this.ready) await this.ready;
    if (!this.checkpointer) await this.init();
    return this.checkpointer;
  }

  private isProduction(): boolean {
    return (this.config.get<string>('NODE_ENV') || process.env.NODE_ENV) === 'production';
  }

  private async init(): Promise<void> {
    try {
      const dbUrl =
        this.config.get<string>('DATABASE_URL') ||
        this.config.get<string>('DB_URL') ||
        process.env.DATABASE_URL ||
        process.env.DB_URL;
      if (dbUrl) {
        try {
          const { PostgresSaver } = await loadPostgresCheckpoint();
          const saver = PostgresSaver.fromConnString(dbUrl);
          await saver.setup();
          this.checkpointer = saver;
          this.logger.log('Lois graph checkpointer: Postgres (conversationId threads)');
          return;
        } catch (err) {
          if (this.isProduction()) {
            this.logger.error(`Postgres checkpointer unavailable in production: ${err}`);
            throw err instanceof Error ? err : new Error(String(err));
          }
          this.logger.warn(`Postgres checkpointer unavailable, using in-memory: ${err}`);
        }
      } else if (this.isProduction()) {
        throw new Error('DATABASE_URL is required for the Lois graph checkpointer in production');
      }
      const MemorySaver = await loadMemorySaver();
      this.checkpointer = new MemorySaver();
      this.logger.log('Lois graph checkpointer: in-memory (interrupts will not survive restart)');
    } catch (err) {
      this.logger.error(`Failed to initialize LangGraph checkpointer: ${err}`);
      if (this.isProduction()) throw err;
      this.checkpointer = null;
    }
  }
}
