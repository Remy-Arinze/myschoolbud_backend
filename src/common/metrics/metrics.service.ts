import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram } from 'prom-client';
import { InjectMetric } from '@willsoto/nestjs-prometheus';

@Injectable()
export class MetricsService {
  constructor(
    // HTTP Layer
    @InjectMetric('http_requests_total') public readonly httpRequestsTotal: Counter<string>,
    @InjectMetric('http_request_duration_seconds') public readonly httpRequestDurationSeconds: Histogram<string>,
    @InjectMetric('http_requests_in_flight') public readonly httpRequestsInFlight: Gauge<string>,
    @InjectMetric('http_errors_total') public readonly httpErrorsTotal: Counter<string>,

    // Authentication
    @InjectMetric('auth_login_attempts_total') public readonly authLoginAttemptsTotal: Counter<string>,
    @InjectMetric('auth_token_refresh_total') public readonly authTokenRefreshTotal: Counter<string>,
    @InjectMetric('auth_failed_attempts_total') public readonly authFailedAttemptsTotal: Counter<string>,
    @InjectMetric('throttler_rejected_requests_total') public readonly throttlerRejectedRequestsTotal: Counter<string>,

    // Lois AI
    @InjectMetric('lois_api_calls_total') public readonly loisApiCallsTotal: Counter<string>,
    @InjectMetric('lois_api_duration_seconds') public readonly loisApiDurationSeconds: Histogram<string>,
    @InjectMetric('lois_verification_total') public readonly loisVerificationTotal: Counter<string>,
    @InjectMetric('lois_curation_total') public readonly loisCurationTotal: Counter<string>,
    @InjectMetric('lois_tokens_consumed_total') public readonly loisTokensConsumedTotal: Counter<string>,
    @InjectMetric('lois_errors_total') public readonly loisErrorsTotal: Counter<string>,
    @InjectMetric('lois_route_total') public readonly loisRouteTotal: Counter<string>,
    @InjectMetric('lois_desks_run_total') public readonly loisDesksRunTotal: Counter<string>,

    // BullMQ Queues
    @InjectMetric('bullmq_jobs_added_total') public readonly bullmqJobsAddedTotal: Counter<string>,
    @InjectMetric('bullmq_jobs_completed_total') public readonly bullmqJobsCompletedTotal: Counter<string>,
    @InjectMetric('bullmq_jobs_failed_total') public readonly bullmqJobsFailedTotal: Counter<string>,
    @InjectMetric('bullmq_jobs_retried_total') public readonly bullmqJobsRetriedTotal: Counter<string>,
    @InjectMetric('bullmq_jobs_cancelled_total') public readonly bullmqJobsCancelledTotal: Counter<string>,
    @InjectMetric('bullmq_job_duration_seconds') public readonly bullmqJobDurationSeconds: Histogram<string>,
    @InjectMetric('bullmq_queue_depth') public readonly bullmqQueueDepth: Gauge<string>,
    @InjectMetric('bullmq_active_jobs') public readonly bullmqActiveJobs: Gauge<string>,

    // Curriculum System
    @InjectMetric('curriculum_generations_total') public readonly curriculumGenerationsTotal: Counter<string>,
    @InjectMetric('curriculum_generation_duration_seconds') public readonly curriculumGenerationDurationSeconds: Histogram<string>,
    @InjectMetric('curriculum_verifications_total') public readonly curriculumVerificationsTotal: Counter<string>,
    @InjectMetric('curriculum_uploads_total') public readonly curriculumUploadsTotal: Counter<string>,
    @InjectMetric('curriculum_parse_duration_seconds') public readonly curriculumParseDurationSeconds: Histogram<string>,
    @InjectMetric('scheme_of_work_published_total') public readonly schemeOfWorkPublishedTotal: Counter<string>,

    // Agora Credits
    @InjectMetric('agora_credits_consumed_total') public readonly agoraCreditsConsumedTotal: Counter<string>,
    @InjectMetric('agora_credits_refunded_total') public readonly agoraCreditsRefundedTotal: Counter<string>,
    @InjectMetric('agora_credit_transactions_total') public readonly agoraCreditTransactionsTotal: Counter<string>,

    // Assessment System
    @InjectMetric('assessments_created_total') public readonly assessmentsCreatedTotal: Counter<string>,
    @InjectMetric('assessments_submitted_total') public readonly assessmentsSubmittedTotal: Counter<string>,
    @InjectMetric('assessment_grading_total') public readonly assessmentGradingTotal: Counter<string>,
    @InjectMetric('assessment_violations_total') public readonly assessmentViolationsTotal: Counter<string>,

    // Redis
    @InjectMetric('redis_connected') public readonly redisConnected: Gauge<string>,
    @InjectMetric('redis_errors_total') public readonly redisErrorsTotal: Counter<string>,

    // Business
    @InjectMetric('active_sessions_total') public readonly activeSessionsTotal: Gauge<string>,
    @InjectMetric('notifications_sent_total') public readonly notificationsSentTotal: Counter<string>,
    @InjectMetric('file_uploads_total') public readonly fileUploadsTotal: Counter<string>,
    @InjectMetric('file_upload_size_bytes') public readonly fileUploadSizeBytes: Histogram<string>,
    @InjectMetric('business_revenue_total') public readonly businessRevenueTotal: Counter<string>,
  ) {}

  // Helper Methods
  incrementHttpRequests(labels: { method: string; route: string; status: string }) {
    this.httpRequestsTotal.inc(labels);
  }

  recordHttpRequestDuration(labels: { method: string; route: string; status: string }, durationSec: number) {
    this.httpRequestDurationSeconds.observe(labels, durationSec);
  }

  incrementHttpErrors(labels: { method: string; route: string; status: string }) {
    this.httpErrorsTotal.inc(labels);
  }

  recordLoisDuration(durationMs: number, labels: { operation: string }) {
    this.loisApiDurationSeconds.observe(labels, durationMs / 1000);
  }

  setQueueDepth(queueName: string, count: number) {
    this.bullmqQueueDepth.set({ queue: queueName }, count);
  }

  incrementCreditsConsumed(labels: { operation: string }, amount: number = 1) {
    this.agoraCreditsConsumedTotal.inc(labels, amount);
  }
}
