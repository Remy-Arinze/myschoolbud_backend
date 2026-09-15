import { Global, Module } from '@nestjs/common';
import { PrometheusModule, makeCounterProvider, makeGaugeProvider, makeHistogramProvider } from '@willsoto/nestjs-prometheus';
import { MetricsService } from './metrics.service';

import { MetricsController } from './metrics.controller';
import { MetricsApiKeyGuard } from './metrics-api-key.guard';

@Global()
@Module({
  imports: [
    PrometheusModule.register({
      path: '/metrics',
      defaultMetrics: {
        enabled: true,
      },
      controller: MetricsController,
    }),
  ],
  providers: [
    MetricsService,
    MetricsApiKeyGuard,
    // HTTP Layer
    makeCounterProvider({
      name: 'http_requests_total',
      help: 'Total number of HTTP requests',
      labelNames: ['method', 'route', 'status'],
    }),
    makeHistogramProvider({
      name: 'http_request_duration_seconds',
      help: 'Duration of HTTP requests in seconds',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.1, 0.3, 0.5, 0.7, 1, 1.5, 2, 5],
    }),
    makeGaugeProvider({
      name: 'http_requests_in_flight',
      help: 'Current concurrent HTTP requests',
    }),
    makeCounterProvider({
      name: 'http_errors_total',
      help: 'Total number of HTTP errors',
      labelNames: ['method', 'route', 'status'],
    }),

    // Authentication
    makeCounterProvider({
      name: 'auth_login_attempts_total',
      help: 'Total auth login attempts',
      labelNames: ['status'],
    }),
    makeCounterProvider({
      name: 'auth_token_refresh_total',
      help: 'Total auth token refreshes',
      labelNames: ['status'],
    }),
    makeCounterProvider({
      name: 'auth_failed_attempts_total',
      help: 'Total failed login attempts by IP',
      labelNames: ['ip'],
    }),
    makeCounterProvider({
      name: 'throttler_rejected_requests_total',
      help: 'Total rejected requests by throttler',
      labelNames: ['tier', 'route'],
    }),

    // Lois AI
    makeCounterProvider({
      name: 'lois_api_calls_total',
      help: 'Total Lois AI API calls',
      labelNames: ['operation', 'status'],
    }),
    makeHistogramProvider({
      name: 'lois_api_duration_seconds',
      help: 'Duration of Lois AI API calls in seconds',
      labelNames: ['operation'],
    }),
    makeCounterProvider({
      name: 'lois_verification_total',
      help: 'Total Lois AI verifications',
      labelNames: ['result'],
    }),
    makeCounterProvider({
      name: 'lois_curation_total',
      help: 'Total Lois AI curations',
      labelNames: ['status'],
    }),
    makeCounterProvider({
      name: 'lois_tokens_consumed_total',
      help: 'Total tokens consumed by Lois AI',
      labelNames: ['direction'],
    }),
    makeCounterProvider({
      name: 'lois_errors_total',
      help: 'Total Lois AI errors',
      labelNames: ['error_type'],
    }),
    makeCounterProvider({
      name: 'lois_route_total',
      help: 'Lois turn-plan route source',
      labelNames: ['source'],
    }),
    makeCounterProvider({
      name: 'lois_desks_run_total',
      help: 'Lois specialist desks started per turn',
      labelNames: ['desk'],
    }),

    // BullMQ Queues
    makeCounterProvider({
      name: 'bullmq_jobs_added_total',
      help: 'Total jobs added to BullMQ',
      labelNames: ['queue', 'job_name'],
    }),
    makeCounterProvider({
      name: 'bullmq_jobs_completed_total',
      help: 'Total jobs completed in BullMQ',
      labelNames: ['queue', 'job_name'],
    }),
    makeCounterProvider({
      name: 'bullmq_jobs_failed_total',
      help: 'Total jobs failed in BullMQ',
      labelNames: ['queue', 'job_name', 'reason'],
    }),
    makeCounterProvider({
      name: 'bullmq_jobs_retried_total',
      help: 'Total jobs retried in BullMQ',
      labelNames: ['queue', 'job_name'],
    }),
    makeCounterProvider({
      name: 'bullmq_jobs_cancelled_total',
      help: 'Total jobs cancelled in BullMQ',
      labelNames: ['queue', 'job_name'],
    }),
    makeHistogramProvider({
      name: 'bullmq_job_duration_seconds',
      help: 'Duration of BullMQ jobs in seconds',
      labelNames: ['queue', 'job_name'],
    }),
    makeGaugeProvider({
      name: 'bullmq_queue_depth',
      help: 'Current depth of BullMQ queues',
      labelNames: ['queue'],
    }),
    makeGaugeProvider({
      name: 'bullmq_active_jobs',
      help: 'Current active jobs in BullMQ',
      labelNames: ['queue'],
    }),

    // Curriculum System
    makeCounterProvider({
      name: 'curriculum_generations_total',
      help: 'Total curriculum generations',
      labelNames: ['mode', 'status'],
    }),
    makeHistogramProvider({
      name: 'curriculum_generation_duration_seconds',
      help: 'Duration of curriculum generations',
      labelNames: ['mode'],
    }),
    makeCounterProvider({
      name: 'curriculum_verifications_total',
      help: 'Total curriculum verifications',
      labelNames: ['result'],
    }),
    makeCounterProvider({
      name: 'curriculum_uploads_total',
      help: 'Total curriculum uploads',
      labelNames: ['file_type', 'status'],
    }),
    makeHistogramProvider({
      name: 'curriculum_parse_duration_seconds',
      help: 'Duration of curriculum parsing',
    }),
    makeCounterProvider({
      name: 'scheme_of_work_published_total',
      help: 'Total schemes of work published',
      labelNames: ['mode'],
    }),

    // Agora Credits
    makeCounterProvider({
      name: 'agora_credits_consumed_total',
      help: 'Total credits consumed',
      labelNames: ['operation'],
    }),
    makeCounterProvider({
      name: 'agora_credits_refunded_total',
      help: 'Total credits refunded',
      labelNames: ['reason'],
    }),
    makeCounterProvider({
      name: 'agora_credit_transactions_total',
      help: 'Total credit transactions',
      labelNames: ['type'],
    }),

    // Assessment System
    makeCounterProvider({
      name: 'assessments_created_total',
      help: 'Total assessments created',
      labelNames: ['type', 'subject'],
    }),
    makeCounterProvider({
      name: 'assessments_submitted_total',
      help: 'Total assessments submitted',
      labelNames: ['type', 'subject'],
    }),
    makeCounterProvider({
      name: 'assessment_grading_total',
      help: 'Total assessments graded',
      labelNames: ['type'],
    }),
    makeCounterProvider({
      name: 'assessment_violations_total',
      help: 'Total assessment violations',
      labelNames: ['type', 'flagged'],
    }),

    // Redis
    makeGaugeProvider({
      name: 'redis_connected',
      help: 'Redis connection status',
    }),
    makeCounterProvider({
      name: 'redis_errors_total',
      help: 'Total redis errors',
    }),

    // Business
    makeGaugeProvider({
      name: 'active_sessions_total',
      help: 'Total active sessions',
    }),
    makeCounterProvider({
      name: 'notifications_sent_total',
      help: 'Total notifications sent',
      labelNames: ['channel', 'type'],
    }),
    makeCounterProvider({
      name: 'business_revenue_total',
      help: 'Total subscription revenue in Naira',
      labelNames: ['tier', 'plan'],
    }),
    makeCounterProvider({
      name: 'file_uploads_total',
      help: 'Total file uploads',
      labelNames: ['file_type', 'status'],
    }),
    makeHistogramProvider({
      name: 'file_upload_size_bytes',
      help: 'Size of file uploads',
    }),
  ],
  exports: [MetricsService],
})
export class MetricsModule {}
