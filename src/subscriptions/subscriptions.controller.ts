import { Controller, Get, Post, Body, Param, Query, UseGuards, Request } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SubscriptionsService } from './subscriptions.service';
import {
  SubscriptionDto,
  SubscriptionSummaryDto,
  ToolAccessResultDto,
  AiCreditsResultDto,
  UseAiCreditsDto,
  TopUpAiCreditsDto,
  ToolDto,
  DowngradeToFreeDto,
} from './dto/subscription.dto';
import { UserWithContext } from '../auth/types/user-with-context.type';
import { SubscriptionBillingService } from './subscription-billing.service';

@Controller('subscriptions')
@UseGuards(JwtAuthGuard)
export class SubscriptionsController {
  constructor(
    private readonly subscriptionsService: SubscriptionsService,
    private readonly subscriptionBillingService: SubscriptionBillingService,
  ) {}

  /**
   * Get current school's subscription
   */
  @Get('my-subscription')
  async getMySubscription(
    @Request() req: { user: UserWithContext }
  ): Promise<{ success: boolean; data: SubscriptionDto }> {
    await this.subscriptionsService.validatePrincipalAccess(req.user);
    const schoolId = req.user.currentSchoolId;

    if (!schoolId) {
      return {
        success: false,
        data: null as any,
      };
    }

    const subscription = await this.subscriptionsService.getOrCreateSubscription(schoolId);

    return {
      success: true,
      data: subscription,
    };
  }

  /**
   * Get subscription summary (lightweight version)
   */
  @Get('summary')
  async getSubscriptionSummary(
    @Request() req: { user: UserWithContext }
  ): Promise<{ success: boolean; data: SubscriptionSummaryDto | null }> {
    const schoolId = req.user.currentSchoolId;

    if (!schoolId) {
      return {
        success: false,
        data: null,
      };
    }

    const summary = await this.subscriptionsService.getSubscriptionSummary(schoolId);
    const showBillingDetails =
      req.user.role === 'SUPER_ADMIN' || (await this.subscriptionsService.isSchoolAdminPrincipal(req.user));
    if (!showBillingDetails && summary.billing) {
      const { billing, ...rest } = summary;
      void billing;
      return { success: true, data: rest as SubscriptionSummaryDto };
    }

    return {
      success: true,
      data: summary,
    };
  }

  /**
   * Get AI usage history for a school (Principal only)
   */
  @Get('ai-usage')
  async getAiUsageHistory(
    @Request() req: { user: UserWithContext },
    @Query('period') period?: string,
  ): Promise<{ success: boolean; data: any[] }> {
    await this.subscriptionsService.validatePrincipalAccess(req.user);
    const schoolId = req.user.currentSchoolId;

    if (!schoolId) {
      return { success: false, data: [] };
    }

    const logs = await this.subscriptionsService.getAiUsageLogs(schoolId, period);

    return {
      success: true,
      data: logs,
    };
  }

  /**
   * Check if current school has access to a specific tool
   */
  @Get('tools/:toolSlug/access')
  async checkToolAccess(
    @Request() req: { user: UserWithContext },
    @Param('toolSlug') toolSlug: string
  ): Promise<{ success: boolean; data: ToolAccessResultDto }> {
    const schoolId = req.user.currentSchoolId;

    if (!schoolId) {
      return {
        success: false,
        data: {
          hasAccess: false,
          status: null,
          tool: null,
          reason: 'school_not_found',
        },
      };
    }

    const result = await this.subscriptionsService.checkToolAccess(schoolId, toolSlug);

    return {
      success: true,
      data: result,
    };
  }

  /**
   * Get all available tools
   */
  @Get('tools')
  async getAllTools(): Promise<{ success: boolean; data: ToolDto[] }> {
    const tools = await this.subscriptionsService.getAllTools();

    return {
      success: true,
      data: tools,
    };
  }

  /**
   * Get tools available for current user's role
   */
  @Get('tools/my-tools')
  async getMyTools(
    @Request() req: { user: UserWithContext }
  ): Promise<{ success: boolean; data: ToolDto[] }> {
    const tools = await this.subscriptionsService.getToolsForRole(req.user.role);

    return {
      success: true,
      data: tools,
    };
  }

  /**
   * Use AI credits
   */
  @Post('ai-credits/use')
  async useAiCredits(
    @Request() req: { user: UserWithContext },
    @Body() dto: UseAiCreditsDto
  ): Promise<{ success: boolean; data: AiCreditsResultDto }> {
    await this.subscriptionsService.validatePrincipalAccess(req.user);
    const schoolId = req.user.currentSchoolId;

    if (!schoolId) {
      return {
        success: false,
        data: {
          success: false,
          creditsUsed: 0,
          creditsRemaining: 0,
          message: 'School context required',
        },
      };
    }

    const result = await this.subscriptionsService.useAiCredits(
      schoolId,
      dto.credits,
      req.user.id,
      dto.action || 'manual_deduction'
    );

    return {
      success: result.success,
      data: result,
    };
  }

  /**
   * Add credits to the school's AI pool (same billing period).
   * Wire a Paystack product to this later; for now principals can top up when credits run low mid-cycle.
   */
  @Post('ai-credits/top-up')
  async topUpAiCredits(
    @Request() req: { user: UserWithContext },
    @Body() dto: TopUpAiCreditsDto,
  ): Promise<{ success: boolean; data: AiCreditsResultDto }> {
    await this.subscriptionsService.validatePrincipalAccess(req.user);
    const schoolId = req.user.currentSchoolId;
    if (!schoolId) {
      return {
        success: false,
        data: {
          success: false,
          creditsUsed: 0,
          creditsRemaining: 0,
          message: 'School context required',
        },
      };
    }
    const data = await this.subscriptionsService.topUpAiCreditPool(schoolId, dto.credits);
    return { success: data.success, data };
  }

  /** Principal: full billing state for admin subscription UX (grace / locked). */
  @Get('billing/admin-state')
  async getAdminBillingState(@Request() req: { user: UserWithContext }) {
    await this.subscriptionsService.validatePrincipalAccess(req.user);
    const schoolId = req.user.currentSchoolId;
    if (!schoolId) return { success: false, data: null };
    const data = await this.subscriptionBillingService.getAdminBillingState(schoolId);
    return { success: true, data };
  }

  /** Dashboard shell: no payment amounts; teachers never see grace payment copy. */
  @Get('billing/ui-flags')
  async getBillingUiFlags(@Request() req: { user: UserWithContext }) {
    const schoolId = req.user.currentSchoolId;
    if (!schoolId) return { success: false, data: null };
    const adminIsPrincipal = await this.subscriptionsService.isSchoolAdminPrincipal(req.user);
    const data = await this.subscriptionBillingService.getUiBillingFlags(
      schoolId,
      req.user.role,
      req.user.currentProfileId,
      adminIsPrincipal,
    );
    return { success: true, data };
  }

  @Get('billing/downgrade-preview')
  async getDowngradePreview(@Request() req: { user: UserWithContext }) {
    await this.subscriptionsService.validatePrincipalAccess(req.user);
    const schoolId = req.user.currentSchoolId;
    if (!schoolId) return { success: false, data: null };
    const data = await this.subscriptionBillingService.getDowngradePreview(schoolId);
    return { success: true, data };
  }

  @Post('billing/downgrade-to-free')
  async downgradeToFree(@Request() req: { user: UserWithContext }, @Body() body: DowngradeToFreeDto) {
    await this.subscriptionsService.validatePrincipalAccess(req.user);
    const schoolId = req.user.currentSchoolId;
    if (!schoolId) return { success: false, message: 'School context required' };
    await this.subscriptionBillingService.executeDowngradeToFree(
      schoolId,
      body.keepEnrollmentIds ?? [],
      req.user.id,
    );
    return { success: true, data: { message: 'Downgrade completed.' } };
  }
}

