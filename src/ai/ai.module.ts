import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiAgentToolsService } from './ai-agent-tools.service';
import { AiChatPromptService } from './ai-chat-prompt.service';
import { AiChatStreamService } from './ai-chat-stream.service';
import { AiContentGeneratorsService } from './ai-content-generators.service';
import { AiContextRagService } from './ai-context-rag.service';
import { AiCurriculumPipelineService } from './ai-curriculum-pipeline.service';
import { AiLlmClientService } from './ai-llm-client.service';
import { AiSchoolChatService } from './ai-school-chat.service';
import { AiService } from './ai.service';
import { KnowledgeIndexingService } from './knowledge-indexing.service';
import { AiController } from './ai.controller';
import { VectorProcessor } from './vector.processor';
import { VectorQueueModule } from './vector-queue.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { DatabaseModule } from '../database/database.module';
import { NotificationModule } from '../notification/notification.module';

import { KnowledgeEventService } from './knowledge-event.service';
import { AiSchoolInsightsService } from './ai-school-insights.service';
import { AiAcademicRiskDigestScheduler } from './ai-academic-risk-digest.scheduler';
import { AiStaffPermissionCheckerService } from './ai-staff-permission-checker.service';
import { AiSchoolQueryService } from './ai-school-query.service';
import { AiInsightsService } from './ai-insights.service';
import { PermissionGuard } from '../common/guards/permission.guard';
import { LoisConfigService } from './lois-config.service';
import { LoisConfigAdminController } from './lois-config-admin.controller';
import { SystemPromptConfigService } from './system-prompt-config.service';
import { LoisSkillsService } from './lois-skills.service';
import { LoisPendingPlanService } from './lois-pending-plan.service';
import { AiCuratorToolsService } from './ai-curator-tools.service';
import { TimetableModule } from '../timetable/timetable.module';
import { LoisCheckpointerService } from './lois-graph/lois-checkpointer.service';
import { LoisRuntimeService } from './lois-graph/lois-runtime.service';

@Module({
  imports: [
    ConfigModule,
    SubscriptionsModule,
    DatabaseModule,
    VectorQueueModule,
    NotificationModule,
    forwardRef(() => TimetableModule),
  ],
  controllers: [AiController, LoisConfigAdminController],
  providers: [
    PermissionGuard,
    AiLlmClientService,
    LoisConfigService,
    SystemPromptConfigService,
    LoisSkillsService,
    LoisPendingPlanService,
    AiCuratorToolsService,
    AiSchoolInsightsService,
    AiStaffPermissionCheckerService,
    AiSchoolQueryService,
    AiInsightsService,
    AiContextRagService,
    AiContentGeneratorsService,
    AiAgentToolsService,
    AiChatPromptService,
    AiSchoolChatService,
    AiChatStreamService,
    LoisCheckpointerService,
    LoisRuntimeService,
    AiCurriculumPipelineService,
    AiService,
    KnowledgeIndexingService,
    VectorProcessor,
    KnowledgeEventService,
    AiAcademicRiskDigestScheduler,
  ],
  exports: [AiService, KnowledgeIndexingService],
})
export class AiModule {}
