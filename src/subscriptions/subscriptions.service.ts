import { Injectable, BadRequestException, NotFoundException, ForbiddenException, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { hasPrincipalAccess } from '../schools/dto/permission.dto';
import { UserWithContext } from '../auth/types/user-with-context.type';
import {
  SubscriptionDto,
  SubscriptionSummaryDto,
  ToolAccessResultDto,
  AiCreditsResultDto,
  SubscriptionTier,
  ToolStatus,
  ToolDto,
  SchoolToolAccessDto,
  SubscriptionBillingPhase,
} from './dto/subscription.dto';
import { applyDevStudentCap } from './subscription-dev.config';

/**
 * Service for managing school subscriptions and tool access
 * Handles subscription tiers, tool access checks, and AI credit management
 */
@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  // Tier limits configuration
  private readonly tierLimits: Record<
    SubscriptionTier,
    { maxStudents: number; maxTeachers: number; maxAdmins: number; aiCredits: number }
  > = {
      [SubscriptionTier.FREE]: { maxStudents: 100, maxTeachers: 10, maxAdmins: 2, aiCredits: 0 },
      [SubscriptionTier.PRO]: { maxStudents: 800, maxTeachers: 80, maxAdmins: 20, aiCredits: 10000 },
      [SubscriptionTier.PRO_PLUS]: {
        maxStudents: 2000,
        maxTeachers: 150,
        maxAdmins: 35,
        aiCredits: 25000,
      },
      [SubscriptionTier.CUSTOM]: {
        maxStudents: -1,
        maxTeachers: -1,
        maxAdmins: -1,
        aiCredits: -1,
      },
    };

  // Tools available per tier
  private readonly tierTools: Record<SubscriptionTier, string[]> = {
    [SubscriptionTier.FREE]: [], // Core platform only
    [SubscriptionTier.PRO]: ['agora-ai'], // Agora AI included
    [SubscriptionTier.PRO_PLUS]: ['agora-ai'], // Agora AI included
    [SubscriptionTier.CUSTOM]: ['agora-ai'], // Custom plans
  };

  constructor(private readonly prisma: PrismaService) { }

  /** Caps used for billing, admissions, and Paystack success handler (keep aligned with `SubscriptionPlan` seed). */
  getTierLimitCaps(tier: SubscriptionTier) {
    const limits = { ...(this.tierLimits[tier] ?? this.tierLimits[SubscriptionTier.FREE]) };
    limits.maxStudents = applyDevStudentCap(tier, limits.maxStudents);
    return limits;
  }

  /**
   * Agora AI is tied to the subscription paid-through date (`endDate`), not the credit counter alone.
   * Unused credits stay on the subscription for rollover when a new paid period is purchased.
   */
  isAiBillingPeriodActive(sub: {
    tier: SubscriptionTier | string;
    endDate: Date | null;
    aiCredits: number;
  }): boolean {
    const now = Date.now();
    const tier = sub.tier as SubscriptionTier;
    if (tier === SubscriptionTier.FREE) {
      return false;
    }

    const endMs = sub.endDate ? new Date(sub.endDate).getTime() : null;

    if (tier === SubscriptionTier.CUSTOM && sub.aiCredits === -1) {
      return endMs === null || endMs > now;
    }
    if (tier === SubscriptionTier.CUSTOM) {
      return endMs !== null && endMs > now;
    }
    // PRO / PRO_PLUS: treat missing endDate as open-ended (legacy); otherwise must be before now.
    if (endMs === null) {
      return true;
    }
    return endMs > now;
  }

  /** Principal-only: add credits to the pool while the billing period is still active. */
  async topUpAiCreditPool(schoolId: string, credits: number): Promise<AiCreditsResultDto> {
    if (!Number.isFinite(credits) || credits < 1) {
      throw new BadRequestException('Invalid credits amount');
    }

    const subscription = await this.prisma.subscription.findUnique({
      where: { schoolId },
    });

    if (!subscription) {
      throw new NotFoundException('Subscription not found');
    }

    if (subscription.aiCredits === -1) {
      return {
        success: true,
        creditsUsed: 0,
        creditsRemaining: -1,
        message: 'This plan has unlimited AI credits.',
      };
    }

    if (!this.isAiBillingPeriodActive(subscription)) {
      throw new ForbiddenException(
        'Credits can only be topped up during an active billing period. Renew your subscription to use AI again; unused credits roll over into the new period.',
      );
    }

    const updated = await this.prisma.subscription.update({
      where: { schoolId },
      data: {
        aiCredits: { increment: credits },
      },
    });

    this.logger.log(`School ${schoolId} AI credit pool topped up by ${credits} (principal)`);

    return {
      success: true,
      creditsUsed: 0,
      creditsRemaining: updated.aiCredits - updated.aiCreditsUsed,
    };
  }

  /**
   * Validate that the current user is a Principal of their school
   */
  async validatePrincipalAccess(user: UserWithContext): Promise<void> {
    if (user.role !== 'SCHOOL_ADMIN' || !user.currentProfileId) {
      // Super admins always have access to these endpoints for monitoring
      if (user.role === 'SUPER_ADMIN') return;

      throw new ForbiddenException('Only school admins can access this resource');
    }

    const admin = await this.prisma.schoolAdmin.findUnique({
      where: { id: user.currentProfileId },
      select: { accessTier: true },
    });

    if (!admin || !hasPrincipalAccess(admin)) {
      throw new ForbiddenException('Only school leaders (Owner, Principal, Head Teacher) can manage subscriptions');
    }
  }

  /** True when the caller is a school admin whose staff role is a principal (subscription / billing UX). */
  async isSchoolAdminPrincipal(user: UserWithContext): Promise<boolean> {
    if (user.role !== 'SCHOOL_ADMIN' || !user.currentProfileId) return false;
    const admin = await this.prisma.schoolAdmin.findUnique({
      where: { id: user.currentProfileId },
      select: { accessTier: true },
    });
    return !!admin && hasPrincipalAccess(admin);
  }

  /**
   * Get or create subscription for a school
   */
  async getOrCreateSubscription(schoolId: string): Promise<SubscriptionDto> {
    let subscription = await this.prisma.subscription.findUnique({
      where: { schoolId },
      include: {
        toolAccess: {
          include: { tool: true },
        },
      },
    });

    // Create FREE subscription if none exists
    if (!subscription) {
      // Find the FREE plan in the database
      const freePlan = await this.prisma.subscriptionPlan.findFirst({
        where: { tierCode: SubscriptionTier.FREE },
      });

      subscription = await this.prisma.subscription.create({
        data: {
          schoolId,
          tier: SubscriptionTier.FREE,
          planId: freePlan?.id,
          maxStudents: freePlan?.maxStudents ?? this.tierLimits[SubscriptionTier.FREE].maxStudents,
          maxTeachers: freePlan?.maxTeachers ?? this.tierLimits[SubscriptionTier.FREE].maxTeachers,
          maxAdmins: freePlan?.maxAdmins ?? this.tierLimits[SubscriptionTier.FREE].maxAdmins,
          aiCredits: freePlan?.aiCredits ?? this.tierLimits[SubscriptionTier.FREE].aiCredits,
        },
        include: {
          toolAccess: {
            include: { tool: true },
          },
        },
      });

      // Initialize tool access based on tier
      await this.syncToolAccessForTier(schoolId, subscription.id, SubscriptionTier.FREE);

      // Refetch with updated tool access
      subscription = await this.prisma.subscription.findUnique({
        where: { schoolId },
        include: {
          toolAccess: {
            include: { tool: true },
          },
        },
      });
    }

    // For existing subscriptions that might be missing a planId (migration side-effect),
    // we link them to the appropriate tier plan if it exists.
    if (subscription && !subscription.planId) {
      const plan = await this.prisma.subscriptionPlan.findFirst({
        where: { tierCode: subscription.tier },
      });
      if (plan) {
        await this.prisma.subscription.update({
          where: { id: subscription.id },
          data: {
            planId: plan.id,
            // If the subscription was using default limits, we sync with the plan's current limits
            maxStudents: plan.maxStudents,
            maxTeachers: plan.maxTeachers,
            maxAdmins: plan.maxAdmins,
            aiCredits: plan.aiCredits,
          },
        });
        // Update local object
        subscription.planId = plan.id;
        subscription.maxStudents = plan.maxStudents;
        subscription.maxTeachers = plan.maxTeachers;
        subscription.maxAdmins = plan.maxAdmins;
        subscription.aiCredits = plan.aiCredits;
      }
    }

    return this.mapToSubscriptionDto(subscription!);
  }

  /**
   * Get subscription summary (lightweight version for frontend)
   */
  async getSubscriptionSummary(schoolId: string): Promise<SubscriptionSummaryDto> {
    const subscription = await this.getOrCreateSubscription(schoolId);
    const row = await (this.prisma.subscription as any).findUnique({
      where: { schoolId },
      select: {
        billingPhase: true,
        gracePeriodEndsAt: true,
        endDate: true,
        isRecurring: true,
        paystackSubscriptionCode: true,
      },
    });

    const aiPeriodActive = this.isAiBillingPeriodActive({
      tier: subscription.tier,
      endDate: subscription.endDate ? new Date(subscription.endDate as Date) : null,
      aiCredits: subscription.aiCredits,
    });

    return {
      tier: subscription.tier,
      isActive: subscription.isActive,
      aiCredits: subscription.aiCredits,
      aiCreditsUsed: subscription.aiCreditsUsed,
      aiCreditsRemaining: subscription.aiCreditsRemaining,
      aiPeriodActive,
      limits: {
        maxStudents: applyDevStudentCap(subscription.tier, subscription.maxStudents),
        maxTeachers: subscription.maxTeachers,
        maxAdmins: subscription.maxAdmins,
      },
      tools: subscription.toolAccess.map((ta) => {
        const baseAccess = ta.status === ToolStatus.ACTIVE || ta.status === ToolStatus.TRIAL;
        const hasAccess =
          ta.tool.slug === 'agora-ai' ? baseAccess && aiPeriodActive : baseAccess;
        return {
          slug: ta.tool.slug,
          name: ta.tool.name,
          status: ta.status,
          hasAccess,
        };
      }),
      billing: row
        ? {
            phase: (row as any).billingPhase as SubscriptionBillingPhase,
            graceEndsAt: (row as any).gracePeriodEndsAt?.toISOString() ?? null,
            paidPeriodEndDate: (row as any).endDate?.toISOString() ?? null,
            isRecurring: (row as any).isRecurring,
            paystackSubscriptionCode: (row as any).paystackSubscriptionCode,
          }
        : undefined,
    };
  }

  /**
   * Check if school has access to a specific tool
   */
  async checkToolAccess(schoolId: string, toolSlug: string): Promise<ToolAccessResultDto> {
    // Get the tool
    const tool = await this.prisma.tool.findUnique({
      where: { slug: toolSlug },
    });

    if (!tool) {
      return {
        hasAccess: false,
        status: null,
        tool: null,
        reason: 'tool_not_found',
      };
    }

    // Get school's tool access
    const toolAccess = await this.prisma.schoolToolAccess.findUnique({
      where: {
        schoolId_toolId: { schoolId, toolId: tool.id },
      },
      include: { tool: true },
    });

    if (!toolAccess) {
      return {
        hasAccess: false,
        status: null,
        tool: this.mapToToolDto(tool),
        reason: 'not_subscribed',
      };
    }

    // Check status
    const now = new Date();

    if (toolAccess.status === ToolStatus.ACTIVE) {
      // Check if expired
      if (toolAccess.expiresAt && toolAccess.expiresAt < now) {
        // Mark as expired
        await this.prisma.schoolToolAccess.update({
          where: { id: toolAccess.id },
          data: { status: 'EXPIRED' },
        });
        return {
          hasAccess: false,
          status: ToolStatus.EXPIRED,
          tool: this.mapToToolDto(tool),
          reason: 'expired',
        };
      }
      if (tool.slug === 'agora-ai') {
        const sub = await this.prisma.subscription.findUnique({
          where: { schoolId },
          select: { tier: true, endDate: true, aiCredits: true },
        });
        if (!sub || !this.isAiBillingPeriodActive(sub)) {
          return {
            hasAccess: false,
            status: ToolStatus.ACTIVE,
            tool: this.mapToToolDto(tool),
            reason: 'billing_period_ended',
          };
        }
      }
      return {
        hasAccess: true,
        status: ToolStatus.ACTIVE,
        tool: this.mapToToolDto(tool),
        reason: 'active',
      };
    }

    if (toolAccess.status === ToolStatus.TRIAL) {
      // Check if trial expired
      if (toolAccess.trialEndsAt && toolAccess.trialEndsAt < now) {
        await this.prisma.schoolToolAccess.update({
          where: { id: toolAccess.id },
          data: { status: 'EXPIRED' },
        });
        return {
          hasAccess: false,
          status: ToolStatus.EXPIRED,
          tool: this.mapToToolDto(tool),
          reason: 'trial_expired',
        };
      }

      const trialDaysRemaining = toolAccess.trialEndsAt
        ? Math.ceil((toolAccess.trialEndsAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
        : 0;

      if (tool.slug === 'agora-ai') {
        const sub = await this.prisma.subscription.findUnique({
          where: { schoolId },
          select: { tier: true, endDate: true, aiCredits: true },
        });
        if (!sub || !this.isAiBillingPeriodActive(sub)) {
          return {
            hasAccess: false,
            status: ToolStatus.TRIAL,
            tool: this.mapToToolDto(tool),
            reason: 'billing_period_ended',
            trialDaysRemaining,
          };
        }
      }

      return {
        hasAccess: true,
        status: ToolStatus.TRIAL,
        tool: this.mapToToolDto(tool),
        reason: 'trial',
        trialDaysRemaining,
      };
    }

    return {
      hasAccess: false,
      status: toolAccess.status as ToolStatus,
      tool: this.mapToToolDto(tool),
      reason: toolAccess.status.toLowerCase(),
    };
  }

  /**
   * Use AI credits for a school
   */
  async useAiCredits(
    schoolId: string,
    credits: number,
    userId: string,
    action?: string
  ): Promise<AiCreditsResultDto> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { schoolId },
    });

    if (!subscription) {
      throw new NotFoundException('Subscription not found');
    }

    if (!this.isAiBillingPeriodActive(subscription)) {
      const creditsRemaining =
        subscription.aiCredits === -1
          ? -1
          : Math.max(0, subscription.aiCredits - subscription.aiCreditsUsed);
      return {
        success: false,
        creditsUsed: 0,
        creditsRemaining,
        message:
          'Your billing period has ended. AI is inactive until you renew; unused credits roll over when you resubscribe.',
      };
    }

    // Check if unlimited
    if (subscription.aiCredits === -1) {
      return {
        success: true,
        creditsUsed: credits,
        creditsRemaining: -1,
      };
    }

    const available = subscription.aiCredits - subscription.aiCreditsUsed;

    if (credits > available) {
      return {
        success: false,
        creditsUsed: 0,
        creditsRemaining: available,
        message: `Insufficient AI credits. Required: ${credits}, Available: ${available}`,
      };
    }

    // Update credits
    const updated = await this.prisma.subscription.update({
      where: { schoolId },
      data: {
        aiCreditsUsed: { increment: credits },
      },
    });

    // Create usage log
    await this.prisma.aiUsageLog.create({
      data: {
        schoolId,
        userId,
        action: action || 'unknown',
        creditsUsed: credits,
      },
    });

    this.logger.log(
      `School ${schoolId} used ${credits} AI credits for ${action || 'unknown action'}`
    );

    return {
      success: true,
      creditsUsed: credits,
      creditsRemaining: updated.aiCredits - updated.aiCreditsUsed,
    };
  }

  /**
   * Refund AI credits for a failed action
   */
  async refundAiCredits(
    schoolId: string,
    credits: number,
    userId: string,
    reason?: string
  ): Promise<AiCreditsResultDto> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { schoolId },
    });

    if (!subscription) {
      throw new NotFoundException('Subscription not found');
    }

    // Update credits (decrement used)
    const updated = await this.prisma.subscription.update({
      where: { schoolId },
      data: {
        aiCreditsUsed: {
          decrement: Math.min(subscription.aiCreditsUsed, credits),
        },
      },
    });

    // Create usage log (negative credits for refund)
    await this.prisma.aiUsageLog.create({
      data: {
        schoolId,
        userId,
        action: `REFUND: ${reason || 'unknown'}`,
        creditsUsed: -credits,
      },
    });

    this.logger.log(
      `School ${schoolId} refunded ${credits} AI credits due to: ${reason || 'unknown reason'}`
    );

    return {
      success: true,
      creditsUsed: -credits,
      creditsRemaining: updated.aiCredits - updated.aiCreditsUsed,
    };
  }

  /**
   * Check if school can add more students
   */
  async checkStudentLimit(
    schoolId: string
  ): Promise<{ canAdd: boolean; currentCount: number; maxAllowed: number; message?: string }> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { schoolId },
    });

    const storedMax =
      subscription?.maxStudents ?? this.tierLimits[SubscriptionTier.FREE].maxStudents;
    const maxStudents = applyDevStudentCap(subscription?.tier, storedMax);

    if (maxStudents === -1) {
      const currentCount = await this.prisma.student.count({
        where: {
          enrollments: { some: { schoolId, isActive: true, billingLocked: false } },
        },
      });
      return { canAdd: true, currentCount, maxAllowed: -1 };
    }

    const currentCount = await this.prisma.student.count({
      where: {
        enrollments: { some: { schoolId, isActive: true, billingLocked: false } },
      },
    });

    if (currentCount >= maxStudents) {
      const tier = subscription?.tier ?? 'FREE';
      return {
        canAdd: false,
        currentCount,
        maxAllowed: maxStudents,
        message: `Your ${tier} plan allows a maximum of ${maxStudents} students. Current: ${currentCount}. Please upgrade your subscription to add more.`,
      };
    }

    return { canAdd: true, currentCount, maxAllowed: maxStudents };
  }

  /**
   * Check if school can add more teachers
   */
  async checkTeacherLimit(
    schoolId: string
  ): Promise<{ canAdd: boolean; currentCount: number; maxAllowed: number; message?: string }> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { schoolId },
    });

    const maxTeachers = subscription?.maxTeachers ?? this.tierLimits[SubscriptionTier.FREE].maxTeachers;

    if (maxTeachers === -1) {
      const currentCount = await this.prisma.teacher.count({ where: { schoolId, billingSuspended: false } });
      return { canAdd: true, currentCount, maxAllowed: -1 };
    }

    const currentCount = await this.prisma.teacher.count({ where: { schoolId, billingSuspended: false } });

    if (currentCount >= maxTeachers) {
      const tier = subscription?.tier ?? 'FREE';
      return {
        canAdd: false,
        currentCount,
        maxAllowed: maxTeachers,
        message: `Your ${tier} plan allows a maximum of ${maxTeachers} teachers. Current: ${currentCount}. Please upgrade your subscription to add more.`,
      };
    }

    return { canAdd: true, currentCount, maxAllowed: maxTeachers };
  }

  /**
   * Check if school can add more admins (based on subscription tier)
   * Returns { canAdd: boolean, currentCount: number, maxAllowed: number, message?: string }
   */
  async checkAdminLimit(
    schoolId: string
  ): Promise<{ canAdd: boolean; currentCount: number; maxAllowed: number; message?: string }> {
    // Get subscription
    const subscription = await this.prisma.subscription.findUnique({
      where: { schoolId },
    });

    // No subscription = FREE tier limits
    const maxAdmins = subscription?.maxAdmins ?? this.tierLimits[SubscriptionTier.FREE].maxAdmins;

    // -1 means unlimited
    if (maxAdmins === -1) {
      const currentCount = await this.prisma.schoolAdmin.count({ where: { schoolId, billingSuspended: false } });
      return { canAdd: true, currentCount, maxAllowed: -1 };
    }

    // Count current admins (exclude billing-suspended seats from cap)
    const currentCount = await this.prisma.schoolAdmin.count({ where: { schoolId, billingSuspended: false } });

    if (currentCount >= maxAdmins) {
      const tier = subscription?.tier ?? 'FREE';
      return {
        canAdd: false,
        currentCount,
        maxAllowed: maxAdmins,
        message: `Your ${tier} plan allows a maximum of ${maxAdmins} administrators. Current: ${currentCount}. Please upgrade your subscription to add more.`,
      };
    }


    return { canAdd: true, currentCount, maxAllowed: maxAdmins };
  }

  /**
   * Get AI credit usage logs for a school
   */
  async getAiUsageLogs(schoolId: string, limit = 50) {
    return this.prisma['aiUsageLog'].findMany({
      where: { schoolId },
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
    });
  }

  /**
   * Get all available tools
   */
  async getAllTools(): Promise<ToolDto[]> {
    const tools = await this.prisma.tool.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
    });

    return tools.map(this.mapToToolDto);
  }

  /**
   * Get tools available for a specific role
   */
  async getToolsForRole(role: string): Promise<ToolDto[]> {
    const tools = await this.prisma.tool.findMany({
      where: {
        isActive: true,
        targetRoles: { has: role },
      },
      orderBy: { sortOrder: 'asc' },
    });

    return tools.map(this.mapToToolDto);
  }

  /**
   * Sync tool access based on subscription tier
   */
  async syncToolAccessForTier(
    schoolId: string,
    subscriptionId: string,
    tier: SubscriptionTier
  ): Promise<void> {
    const allowedToolSlugs = this.tierTools[tier];

    // Get all tools
    const allTools = await this.prisma.tool.findMany({
      where: { isActive: true },
    });

    for (const tool of allTools) {
      const isAllowed = allowedToolSlugs.includes(tool.slug);

      // Check existing access
      const existing = await this.prisma.schoolToolAccess.findUnique({
        where: {
          schoolId_toolId: { schoolId, toolId: tool.id },
        },
      });

      if (isAllowed) {
        // Grant or update access
        if (existing) {
          if (existing.status !== 'ACTIVE') {
            await this.prisma.schoolToolAccess.update({
              where: { id: existing.id },
              data: {
                status: 'ACTIVE',
                subscriptionId,
                activatedAt: new Date(),
              },
            });
          }
        } else {
          await this.prisma.schoolToolAccess.create({
            data: {
              schoolId,
              toolId: tool.id,
              subscriptionId,
              status: 'ACTIVE',
              activatedAt: new Date(),
            },
          });
        }
      } else {
        // Revoke access if not allowed
        if (existing && existing.status === 'ACTIVE') {
          await this.prisma.schoolToolAccess.update({
            where: { id: existing.id },
            data: { status: 'DISABLED' },
          });
        }
      }
    }
  }

  /**
   * Map Prisma subscription to DTO
   */
  private mapToSubscriptionDto(subscription: any): SubscriptionDto {
    return {
      id: subscription.id,
      schoolId: subscription.schoolId,
      tier: subscription.tier as SubscriptionTier,
      startDate: subscription.startDate,
      endDate: subscription.endDate,
      isActive: subscription.isActive,
      maxStudents: applyDevStudentCap(subscription.tier, subscription.maxStudents),
      maxTeachers: subscription.maxTeachers,
      maxAdmins: subscription.maxAdmins,
      aiCredits: subscription.aiCredits,
      aiCreditsUsed: subscription.aiCreditsUsed,
      aiCreditsRemaining: subscription.aiCredits - subscription.aiCreditsUsed,
      toolAccess: (subscription.toolAccess || []).map((ta: any) => this.mapToToolAccessDto(ta)),
    };
  }

  /**
   * Map Prisma tool to DTO
   */
  private mapToToolDto(tool: any): ToolDto {
    return {
      id: tool.id,
      slug: tool.slug,
      name: tool.name,
      description: tool.description,
      icon: tool.icon,
      monthlyPrice: Number(tool.monthlyPrice),
      yearlyPrice: Number(tool.yearlyPrice),
      isCore: tool.isCore,
      isActive: tool.isActive,
      features: tool.features as { name: string; description: string }[] | null,
      targetRoles: tool.targetRoles,
    };
  }

  /**
   * Map Prisma tool access to DTO
   */
  private mapToToolAccessDto(toolAccess: any): SchoolToolAccessDto {
    return {
      id: toolAccess.id,
      toolId: toolAccess.toolId,
      tool: this.mapToToolDto(toolAccess.tool),
      status: toolAccess.status as ToolStatus,
      trialEndsAt: toolAccess.trialEndsAt,
      activatedAt: toolAccess.activatedAt,
      expiresAt: toolAccess.expiresAt,
    };
  }
}
