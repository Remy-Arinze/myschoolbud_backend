import { IsString, IsOptional, IsEnum, IsInt, Min, IsBoolean, IsDateString, IsArray } from 'class-validator';

// Enums matching Prisma schema
export enum SubscriptionTier {
  FREE = 'FREE',
  PRO = 'PRO',
  PRO_PLUS = 'PRO_PLUS',
  CUSTOM = 'CUSTOM',
}

export enum ToolStatus {
  ACTIVE = 'ACTIVE',
  TRIAL = 'TRIAL',
  EXPIRED = 'EXPIRED',
  DISABLED = 'DISABLED',
}

// Response DTOs
export class ToolDto {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
  monthlyPrice: number;
  yearlyPrice: number;
  isCore: boolean;
  isActive: boolean;
  features: { name: string; description: string }[] | null;
  targetRoles: string[];
}

export class SchoolToolAccessDto {
  id: string;
  toolId: string;
  tool: ToolDto;
  status: ToolStatus;
  trialEndsAt: Date | null;
  activatedAt: Date | null;
  expiresAt: Date | null;
}

export class SubscriptionDto {
  id: string;
  schoolId: string;
  tier: SubscriptionTier;
  startDate: Date;
  endDate: Date | null;
  isActive: boolean;
  maxStudents: number;
  maxTeachers: number;
  maxAdmins: number;
  aiCredits: number;
  aiCreditsUsed: number;
  aiCreditsRemaining: number;
  toolAccess: SchoolToolAccessDto[];
}

export type SubscriptionBillingPhase = 'OK' | 'GRACE_PERIOD' | 'ADMIN_ACTION_REQUIRED';

export class SubscriptionBillingSummaryDto {
  phase: SubscriptionBillingPhase;
  graceEndsAt: string | null;
  paidPeriodEndDate: string | null;
  isRecurring?: boolean;
  paystackSubscriptionCode?: string | null;
}

export class SubscriptionSummaryDto {
  tier: SubscriptionTier;
  isActive: boolean;
  aiCredits: number;
  aiCreditsUsed: number;
  aiCreditsRemaining: number;
  /** False when the paid-through date has passed; AI is off even if credits remain (they roll over on renewal). */
  aiPeriodActive?: boolean;
  limits: {
    maxStudents: number;
    maxTeachers: number;
    maxAdmins: number;
  };
  usage?: {
    students: number;
    teachers: number;
    admins: number;
  };
  tools: {
    slug: string;
    name: string;
    status: ToolStatus;
    hasAccess: boolean;
  }[];
  /** Present when subscription row includes billing lifecycle fields. */
  billing?: SubscriptionBillingSummaryDto;
}

/** Principal-only: IDs of enrollments that stay ACTIVE after downgrade to Free (exactly free tier cap when over cap). */
export class DowngradeToFreeDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  keepEnrollmentIds?: string[];
}

// Request DTOs
export class CheckToolAccessDto {
  @IsString()
  toolSlug: string;
}

export class UseAiCreditsDto {
  @IsInt()
  @Min(1)
  credits: number;

  @IsString()
  @IsOptional()
  action?: string; // e.g., "generate_flashcards", "grade_essay"
}

/** Principal-only: increase the school's AI credit pool during an active billing period. */
export class TopUpAiCreditsDto {
  @IsInt()
  @Min(1)
  credits: number;
}

export class UpgradeSubscriptionDto {
  @IsEnum(SubscriptionTier)
  tier: SubscriptionTier;

  @IsBoolean()
  @IsOptional()
  isYearly?: boolean;
}

// Tool access check response
export class ToolAccessResultDto {
  hasAccess: boolean;
  status: ToolStatus | null;
  tool: ToolDto | null;
  reason?: string; // "active", "trial", "expired", "not_subscribed", "school_not_found"
  trialDaysRemaining?: number;
}

// AI Credits response
export class AiCreditsResultDto {
  success: boolean;
  creditsUsed: number;
  creditsRemaining: number;
  message?: string;
}

