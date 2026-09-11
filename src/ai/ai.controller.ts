import { Body, Controller, Post, Get, Delete, Put, UseGuards, Request, Param, BadRequestException, ForbiddenException, Query, Res, Header } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { SchoolDataAccessGuard } from '../common/guards/school-data-access.guard';
import { PermissionGuard } from '../common/guards/permission.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/permission.decorator';
import { PermissionResource, PermissionType } from '../schools/dto/permission.dto';
import { AiService } from './ai.service';
import { LoisConfigService } from './lois-config.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { SubscriptionBillingService } from '../subscriptions/subscription-billing.service';
import { KnowledgeIndexingService } from './knowledge-indexing.service';
import { PrismaService } from '../database/prisma.service';
import { AiInsightsService } from './ai-insights.service';
import { AiStaffPermissionCheckerService } from './ai-staff-permission-checker.service';
import { AiCuratorToolsService } from './ai-curator-tools.service';
import { LoisPendingPlanService } from './lois-pending-plan.service';
import { LoisRuntimeService } from './lois-graph/lois-runtime.service';
import {
    GenerateQuizDto,
    GenerateAssessmentDto,
    GradeEssayDto,
    GenerateLessonPlanDto
} from './dto/ai.dto';
import { UserRole } from '@prisma/client';
import { Response } from 'express';
import { toLoisStreamErrorPayload } from './ai-stream-errors';

/**
 * heavy-ai tier: Protects against excessive LLM token usage and high-compute indexing operations.
 */
@ApiTags('AI Features')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, SchoolDataAccessGuard, RolesGuard, PermissionGuard)
@Throttle({ 'heavy-ai': { limit: 10, ttl: 60000 } })
@Controller('schools/:schoolId/ai')
export class AiController {
    constructor(
        private readonly aiService: AiService,
        private readonly loisConfigService: LoisConfigService,
        private readonly subscriptionsService: SubscriptionsService,
        private readonly subscriptionBilling: SubscriptionBillingService,
        private readonly indexingService: KnowledgeIndexingService,
        private readonly prisma: PrismaService,
        private readonly insightsService: AiInsightsService,
        private readonly staffPermissions: AiStaffPermissionCheckerService,
        private readonly curatorTools: AiCuratorToolsService,
        private readonly pendingPlans: LoisPendingPlanService,
        private readonly loisRuntime: LoisRuntimeService,
    ) { }

    /**
     * Pre-check to ensure school has access and some credits available
     */
    private async verifyAccess(schoolId: string) {
        if (!this.aiService.isConfigured()) {
            throw new BadRequestException('OpenAI is not configured. Please add OPENAI_API_KEY.');
        }

        const toolAccess = await this.subscriptionsService.checkToolAccess(schoolId, 'agora-ai');
        if (!toolAccess.hasAccess) {
            throw new BadRequestException('School does not have access to Myschoolbud AI tools. Please upgrade your subscription.');
        }

        const summary = await this.subscriptionsService.getSubscriptionSummary(schoolId);
        if (summary.aiCreditsRemaining <= 0 && summary.tier !== 'CUSTOM') {
            throw new BadRequestException('Insufficient AI credits. Please upgrade your subscription.');
        }

        return summary;
    }

    /** Staff/student billing limits for AI (no OpenAI pre-check). */
    private async assertAiBillingForRequest(req: any, schoolId: string): Promise<void> {
        if (req.user.role === UserRole.TEACHER && req.user.currentProfileId) {
            await this.subscriptionBilling.assertTeacherMayWrite(schoolId, req.user.currentProfileId);
        }
        if (req.user.role === UserRole.SCHOOL_ADMIN && req.user.currentProfileId) {
            await this.subscriptionBilling.assertSchoolAdminNotBillingSuspended(schoolId, req.user.currentProfileId);
        }
        if (req.user.role === UserRole.STUDENT) {
            const st = await this.prisma.student.findUnique({
                where: { userId: req.user.id },
                select: { id: true },
            });
            if (!st) {
                throw new ForbiddenException('Student profile not found');
            }
            await this.subscriptionBilling.assertStudentEnrollmentOperational(st.id, schoolId);
        }
    }

    private async verifyAccessWithBilling(req: any, schoolId: string) {
        const summary = await this.verifyAccess(schoolId);
        await this.assertAiBillingForRequest(req, schoolId);
        return summary;
    }

    /**
     * Dynamically calculate actual credits based on language model limits
     */
    private async calculateAndDeductTokensFromUsage(schoolId: string, userId: string, usage: any, actionName: string) {
        if (!usage || !usage.total_tokens) return;
        
        // Use the exchange rate variable from environment, defaults to 1000
        const exchangeRate = Number(process.env.AGORA_CREDITS_PER_1M_TOKENS) || 1000;
        
        // Mathematically calculate raw tokens used to Agora credits
        const tokensToDeduct = Math.ceil(usage.total_tokens * (exchangeRate / 1000000));
        
        // Ensure at least 1 credit is burned if a request happened
        const credits = Math.max(1, tokensToDeduct);
        
        await this.subscriptionsService.useAiCredits(schoolId, credits, userId, actionName);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SSE STREAMING + AGENTIC CHAT (New Primary Endpoint)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Heavy-AI: AI streaming consumes significant server resources per request.
     */
    @Post('chat/stream')
    @Roles(UserRole.TEACHER, UserRole.SCHOOL_ADMIN, UserRole.STUDENT)
    @RequirePermission(PermissionResource.OVERVIEW, PermissionType.READ)
    @ApiOperation({ summary: 'Stream AI chat with agentic tool-calling via SSE' })
    async chatStream(
        @Request() req: any,
        @Param('schoolId') schoolId: string,
        @Body() body: { messages: any[]; conversationId?: string; pageContext?: any },
        @Res() res: Response
    ) {
        let finalUsage = { total_tokens: 0 };

        try {
            const summary = await this.verifyAccessWithBilling(req, schoolId);
            const exchangeRate = Number(process.env.AGORA_CREDITS_PER_1M_TOKENS) || 1000;
            const remainingTokens = summary.tier === 'CUSTOM' ? Infinity : Math.max(0, (summary.aiCreditsRemaining * 1000000) / exchangeRate);

            // Set SSE headers
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            res.flushHeaders();

            // Handle client disconnect
            const abortController = new AbortController();
            req.on('close', () => {
                abortController.abort();
            });

            finalUsage = await this.aiService.chatStreamSSE(
                res,
                body.messages,
                req.user.id,
                body.conversationId,
                schoolId,
                remainingTokens,
                abortController.signal,
                body.pageContext,
            );
        } catch (error: any) {
            const payload = toLoisStreamErrorPayload(error);
            if (!res.headersSent) {
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('X-Accel-Buffering', 'no');
                res.flushHeaders();
            }
            res.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
        } finally {
            // Deduct credits based on exact tracked token usage 
            try {
                if (finalUsage && finalUsage.total_tokens > 0) {
                    await this.calculateAndDeductTokensFromUsage(
                        schoolId,
                        req.user.id,
                        finalUsage,
                        'ai_chat_stream'
                    );
                }
            } catch (e) {
                // Credit deduction failure should not break the stream
            }
            res.end();
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // EXISTING ENDPOINTS (Preserved)
    // ─────────────────────────────────────────────────────────────────────────

    @Post('quiz')
    @Roles(UserRole.TEACHER, UserRole.SCHOOL_ADMIN)
    @RequirePermission(PermissionResource.CURRICULUM, PermissionType.READ)
    @ApiOperation({ summary: 'Generate a short quiz' })
    async generateQuiz(
        @Request() req: any,
        @Param('schoolId') schoolId: string,
        @Body() dto: GenerateQuizDto
    ) {
        await this.verifyAccessWithBilling(req, schoolId);
        const { data, usage } = await this.aiService.generateQuiz(dto);
        await this.calculateAndDeductTokensFromUsage(schoolId, req.user.id, usage, 'generate_quiz');
        return data;
    }

    @Post('assessment')
    @Roles(UserRole.TEACHER, UserRole.SCHOOL_ADMIN)
    @RequirePermission(PermissionResource.CURRICULUM, PermissionType.READ)
    @ApiOperation({ summary: 'Generate a comprehensive assessment' })
    async generateAssessment(
        @Request() req: any,
        @Param('schoolId') schoolId: string,
        @Body() dto: GenerateAssessmentDto
    ) {
        await this.verifyAccessWithBilling(req, schoolId);
        const { data, usage } = await this.aiService.generateAssessmentQuestions(dto);
        await this.calculateAndDeductTokensFromUsage(schoolId, req.user.id, usage, 'generate_assessment');
        return data;
    }

    @Post('lesson-plan')
    @Roles(UserRole.TEACHER, UserRole.SCHOOL_ADMIN)
    @RequirePermission(PermissionResource.CURRICULUM, PermissionType.READ)
    @ApiOperation({ summary: 'Generate a lesson plan' })
    async generateLessonPlan(
        @Request() req: any,
        @Param('schoolId') schoolId: string,
        @Body() dto: GenerateLessonPlanDto
    ) {
        await this.verifyAccessWithBilling(req, schoolId);
        const { data, usage } = await this.aiService.generateLessonPlan(dto);
        await this.calculateAndDeductTokensFromUsage(schoolId, req.user.id, usage, 'generate_lesson_plan');
        return data;
    }

    @Post('grade-essay')
    @Roles(UserRole.TEACHER, UserRole.SCHOOL_ADMIN)
    @RequirePermission(PermissionResource.GRADES, PermissionType.READ)
    @ApiOperation({ summary: 'Grade a student essay' })
    async gradeEssay(
        @Request() req: any,
        @Param('schoolId') schoolId: string,
        @Body() dto: GradeEssayDto
    ) {
        await this.verifyAccessWithBilling(req, schoolId);
        const { data, usage } = await this.aiService.gradeEssay(dto);
        await this.calculateAndDeductTokensFromUsage(schoolId, req.user.id, usage, 'grade_essay');
        return data;
    }

    @Post('chat')
    @Roles(UserRole.TEACHER, UserRole.SCHOOL_ADMIN, UserRole.STUDENT)
    @RequirePermission(PermissionResource.OVERVIEW, PermissionType.READ)
    @ApiOperation({ summary: 'Generic AI assistant chat (legacy, non-streaming)' })
    async chat(
        @Request() req: any,
        @Param('schoolId') schoolId: string,
        @Body() body: { messages: any[]; conversationId?: string }
    ) {
        await this.verifyAccessWithBilling(req, schoolId);
        const { data, usage } = await this.aiService.chat(body.messages, req.user.id, body.conversationId, schoolId);
        await this.calculateAndDeductTokensFromUsage(schoolId, req.user.id, usage, 'ai_chat');
        return data;
    }

    @Get('history')
    @Roles(UserRole.TEACHER, UserRole.SCHOOL_ADMIN, UserRole.STUDENT)
    @RequirePermission(PermissionResource.OVERVIEW, PermissionType.READ)
    @ApiOperation({ summary: 'Get chat history' })
    async getHistory(@Request() req: any, @Param('schoolId') schoolId: string) {
        await this.assertAiBillingForRequest(req, schoolId);
        return this.aiService.getConversations(req.user.id, schoolId);
    }

    @Get('history/:conversationId')
    @Roles(UserRole.TEACHER, UserRole.SCHOOL_ADMIN, UserRole.STUDENT)
    @RequirePermission(PermissionResource.OVERVIEW, PermissionType.READ)
    @ApiOperation({ summary: 'Get messages for a conversation' })
    async getConversationMessages(
        @Request() req: any,
        @Param('schoolId') schoolId: string,
        @Param('conversationId') conversationId: string
    ) {
        await this.assertAiBillingForRequest(req, schoolId);
        return this.aiService.getConversationMessages(conversationId, req.user.id, schoolId);
    }

    @Delete('history/:conversationId')
    @Roles(UserRole.TEACHER, UserRole.SCHOOL_ADMIN, UserRole.STUDENT)
    @RequirePermission(PermissionResource.OVERVIEW, PermissionType.READ)
    @ApiOperation({ summary: 'Delete a conversation' })
    async deleteConversation(
        @Request() req: any,
        @Param('schoolId') schoolId: string,
        @Param('conversationId') conversationId: string
    ) {
        await this.assertAiBillingForRequest(req, schoolId);
        return this.aiService.deleteConversation(conversationId, req.user.id, schoolId);
    }

    /**
     * Apply a Lois pending plan by id (button → HTTP). Solver writes; the model does not apply.
     * Timetable apply does not spend AI credits. Scheme apply uses setupSchemeOfWork (credits for SCHOOL_ONLY/MERGED).
     */
    @Post('plans/:planId/apply')
    @Roles(UserRole.SCHOOL_ADMIN)
    @RequirePermission(PermissionResource.OVERVIEW, PermissionType.READ)
    @ApiOperation({ summary: 'Apply a Lois pending timetable or scheme plan by id' })
    async applyPendingPlan(
        @Request() req: any,
        @Param('schoolId') schoolId: string,
        @Param('planId') planId: string,
        @Body() body: { conversationId?: string },
    ) {
        await this.assertAiBillingForRequest(req, schoolId);
        const plan = await this.pendingPlans.peek(planId, req.user.id, schoolId);
        await this.staffPermissions.assertLoisPlanWrite({
            kind: plan.kind,
            userRole: req.user.role,
            userId: req.user.id,
            schoolId,
        });
        const data = await this.curatorTools.applyPlan(planId, {
            schoolId,
            userId: req.user.id,
            user: req.user,
            conversationId: body?.conversationId,
        });
        void this.loisRuntime.resumeAfterHitl({
            conversationId: body?.conversationId || plan.conversationId,
            userId: req.user.id,
            schoolId,
            userRole: req.user.role,
            decision: { applied: true },
        });
        return { success: true, data };
    }

    @Post('plans/:planId/cancel')
    @Roles(UserRole.SCHOOL_ADMIN)
    @RequirePermission(PermissionResource.OVERVIEW, PermissionType.READ)
    @ApiOperation({ summary: 'Cancel a Lois pending plan' })
    async cancelPendingPlan(
        @Request() req: any,
        @Param('schoolId') schoolId: string,
        @Param('planId') planId: string,
    ) {
        const plan = await this.pendingPlans.peek(planId, req.user.id, schoolId).catch(() => null);
        const data = await this.pendingPlans.cancel(planId, req.user.id, schoolId);
        if (plan?.conversationId) {
            void this.loisRuntime.resumeAfterHitl({
                conversationId: plan.conversationId,
                userId: req.user.id,
                schoolId,
                userRole: req.user.role,
                decision: { cancelled: true },
            });
        }
        return { success: true, data };
    }

    @Get('insights')
    @Roles(UserRole.SCHOOL_ADMIN)
    @ApiOperation({ summary: 'Latest Lois background insights this admin is allowed to see' })
    async listInsights(
        @Request() req: any,
        @Param('schoolId') schoolId: string,
        @Query('limit') limit?: string,
    ) {
        const types = await this.staffPermissions.allowedInsightTypes(
            req.user?.id,
            schoolId,
            req.user?.role,
        );
        const insights = await this.insightsService.listForSchool(
            schoolId,
            limit ? parseInt(limit, 10) : 8,
            types,
            req.user?.id,
        );
        return { success: true, data: insights };
    }

    @Get('insights/:insightId')
    @Roles(UserRole.SCHOOL_ADMIN)
    @ApiOperation({ summary: 'One Lois insight, if this admin has access to its type' })
    async getInsight(
        @Request() req: any,
        @Param('schoolId') schoolId: string,
        @Param('insightId') insightId: string,
    ) {
        const types = await this.staffPermissions.allowedInsightTypes(
            req.user?.id,
            schoolId,
            req.user?.role,
        );
        const insight = await this.insightsService.getById(schoolId, insightId, types, req.user?.id);
        return { success: true, data: insight };
    }

    @Post('insights/:insightId/read')
    @Roles(UserRole.SCHOOL_ADMIN)
    @ApiOperation({ summary: 'Mark a Lois briefing as read for this admin' })
    async markInsightRead(
        @Request() req: any,
        @Param('schoolId') schoolId: string,
        @Param('insightId') insightId: string,
    ) {
        const types = await this.staffPermissions.allowedInsightTypes(
            req.user?.id,
            schoolId,
            req.user?.role,
        );
        const insight = await this.insightsService.markRead(
            schoolId,
            insightId,
            req.user.id,
            types,
        );
        return { success: true, data: insight };
    }

    @Post('index-school')
    @Roles(UserRole.SCHOOL_ADMIN, UserRole.SUPER_ADMIN)
    @RequirePermission(PermissionResource.ANALYTICS, PermissionType.READ)
    @ApiOperation({ summary: 'Trigger knowledge indexing for the school' })
    async indexSchool(@Request() req: any, @Param('schoolId') schoolId: string) {
        if (req.user?.role === UserRole.SCHOOL_ADMIN && req.user?.currentProfileId) {
            await this.subscriptionBilling.assertSchoolAdminNotBillingSuspended(schoolId, req.user.currentProfileId);
        }
        // Trigger background sync for school, teachers, and classes
        await this.indexingService.syncSchool(schoolId);

        // Also sync students (limited for now to avoid timeout)
        const students = await this.prisma.student.findMany({
            where: { enrollments: { some: { schoolId } } },
            select: { id: true },
            take: 100 // Limit for manual trigger
        });

        for (const s of students) {
            await this.indexingService.triggerEntitySync('student', s.id);
        }

        return { 
            success: true, 
            message: `School knowledge base updated. Indexed school profiles, teachers, and ${students.length} students.` 
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // LOIS CONFIGURATION (Per-school personality customisation)
    // ─────────────────────────────────────────────────────────────────────────

    /** School admin: fetch their school's Lois config */
    @Get('lois-config')
    @Roles(UserRole.SCHOOL_ADMIN)
    @RequirePermission(PermissionResource.OVERVIEW, PermissionType.READ)
    @ApiOperation({ summary: 'Get Lois configuration for this school' })
    async getLoisConfig(@Param('schoolId') schoolId: string) {
        const config = await this.loisConfigService.getForSchool(schoolId);
        return { success: true, data: config ?? null };
    }

    /** School admin (principal only): save their Lois config */
    @Put('lois-config')
    @Roles(UserRole.SCHOOL_ADMIN)
    @RequirePermission(PermissionResource.OVERVIEW, PermissionType.WRITE)
    @ApiOperation({ summary: 'Save Lois configuration for this school (principal only)' })
    async upsertLoisConfig(
        @Request() req: any,
        @Param('schoolId') schoolId: string,
        @Body() body: { customGreeting?: string; toneNote?: string; restrictedTopics?: string; schoolContext?: string },
    ) {
        // Only school owners / principals may edit Lois config
        const admin = await this.prisma.schoolAdmin.findFirst({
            where: { userId: req.user.id, schoolId },
            select: { role: true },
        });
        const principalRoles = ['school_owner', 'principal', 'head_teacher', 'headmaster', 'headmistress'];
        if (!admin || !principalRoles.includes(admin.role?.toLowerCase() ?? '')) {
            throw new ForbiddenException('Only the school principal or owner can modify Lois configuration.');
        }

        const config = await this.loisConfigService.upsertForSchool(schoolId, body);
        return { success: true, data: config };
    }

    /** School admin (principal only): reset Lois config to defaults */
    @Delete('lois-config')
    @Roles(UserRole.SCHOOL_ADMIN)
    @RequirePermission(PermissionResource.OVERVIEW, PermissionType.WRITE)
    @ApiOperation({ summary: 'Reset Lois configuration to platform defaults' })
    async deleteLoisConfig(
        @Request() req: any,
        @Param('schoolId') schoolId: string,
    ) {
        const admin = await this.prisma.schoolAdmin.findFirst({
            where: { userId: req.user.id, schoolId },
            select: { role: true },
        });
        const principalRoles = ['school_owner', 'principal', 'head_teacher', 'headmaster', 'headmistress'];
        if (!admin || !principalRoles.includes(admin.role?.toLowerCase() ?? '')) {
            throw new ForbiddenException('Only the school principal or owner can reset Lois configuration.');
        }
        await this.loisConfigService.deleteForSchool(schoolId);
        return { success: true, message: 'Lois configuration reset to platform defaults.' };
    }
}
