import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DASHBOARD_CACHE_INVALIDATE } from '../common/redis/dashboard-cache.events';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private _extendedClient: any;

  constructor(private eventEmitter: EventEmitter2) {
    super();
  }

  get client() {
    if (!this._extendedClient) {
      this._extendedClient = this.$extends({
        query: {
          $allModels: {
            async $allOperations({ args, query }) {
              return query(args);
            },
          },
        },
      });
    }
    return this._extendedClient;
  }

  // NOTE: To utilize the extension, we need all services to use prismaService.client instead of this directly.
  // However, simpler is to just use the existing $use (for now) but emit events from it, 
  // or use the new Prisma Client Extensions but re-assigned.
  // Actually, Middleware ($use) is easier to inject with EventEmitter without breaking inheritance.

  async onModuleInit() {
    try {
      await this.$connect();
      this.logger.log('✅ Database connected successfully');
      
      // Layer 1 — Event-Driven Indexing via Middleware (covers all services)
      this.$use(async (params, next) => {
        const result = await next(params);

        const dashboardModels = new Set([
          'Enrollment',
          'Teacher',
          'Class',
          'AdmissionApplication',
          'ClassArm',
          'Student',
        ]);
        if (
          dashboardModels.has(params.model || '') &&
          ['create', 'update', 'upsert', 'delete', 'updateMany', 'deleteMany'].includes(params.action)
        ) {
          const schoolId =
            (result && typeof result === 'object' && 'schoolId' in result
              ? (result as { schoolId?: string }).schoolId
              : undefined) ||
            params.args?.data?.schoolId ||
            params.args?.where?.schoolId;
          if (typeof schoolId === 'string' && schoolId) {
            this.eventEmitter.emit(DASHBOARD_CACHE_INVALIDATE, { schoolId });
          }
        }

        return result;
      });

    } catch (error) {
      this.logger.error('❌ Failed to connect to database.');
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
