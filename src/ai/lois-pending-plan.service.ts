import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { LOIS_CURATOR_PLAN_TTL_MS } from '../timetable/timetable-curator.constants';
import { classLabelMatches, payloadClassLabel } from './lois-plan-facing';

export type PendingPlanKind = 'TIMETABLE' | 'SCHEME';
export type PendingPlanApplyKind = PendingPlanKind | 'ALL';

@Injectable()
export class LoisPendingPlanService {
  constructor(private readonly prisma: PrismaService) {}

  private get model() {
    return (this.prisma as any).loisPendingPlan;
  }

  async create(params: {
    userId: string;
    schoolId: string;
    conversationId?: string | null;
    kind: PendingPlanKind;
    payload: unknown;
    summary: string;
  }) {
    const expiresAt = new Date(Date.now() + LOIS_CURATOR_PLAN_TTL_MS);
    return this.model.create({
      data: {
        userId: params.userId,
        schoolId: params.schoolId,
        conversationId: params.conversationId || null,
        kind: params.kind,
        payload: params.payload as object,
        summary: params.summary,
        expiresAt,
        status: 'PROPOSED',
      },
    });
  }

  async peek(planId: string, userId: string, schoolId: string) {
    const plan = await this.model.findUnique({ where: { id: planId } });
    if (!plan) throw new NotFoundException('That plan is no longer available. Ask Lois to propose again.');
    if (plan.userId !== userId || plan.schoolId !== schoolId) {
      throw new ForbiddenException('This plan belongs to another session.');
    }
    return plan;
  }

  async getActive(planId: string, userId: string, schoolId: string, conversationId?: string | null) {
    const plan = await this.peek(planId, userId, schoolId);
    if (conversationId && plan.conversationId && plan.conversationId !== conversationId) {
      throw new ForbiddenException('This plan belongs to another conversation.');
    }
    if (plan.status === 'APPLIED') {
      throw new BadRequestException('This plan was already applied.');
    }
    if (plan.status === 'CANCELLED') {
      throw new BadRequestException('This plan was cancelled.');
    }
    if (plan.status !== 'PROPOSED' || new Date(plan.expiresAt).getTime() < Date.now()) {
      await this.model.update({ where: { id: planId }, data: { status: 'EXPIRED' } });
      throw new BadRequestException('This plan expired. Ask Lois to propose again.');
    }
    return plan;
  }

  async markApplied(planId: string) {
    return this.model.update({ where: { id: planId }, data: { status: 'APPLIED' } });
  }

  async cancel(planId: string, userId: string, schoolId: string) {
    const plan = await this.getActive(planId, userId, schoolId).catch(() => null);
    if (!plan) return { cancelled: false };
    await this.model.update({ where: { id: planId }, data: { status: 'CANCELLED' } });
    return { cancelled: true };
  }

  async listActive(params: {
    userId: string;
    schoolId: string;
    conversationId?: string | null;
    kind?: PendingPlanApplyKind;
  }) {
    const now = new Date();
    const where: Record<string, unknown> = {
      userId: params.userId,
      schoolId: params.schoolId,
      status: 'PROPOSED',
    };
    if (params.kind && params.kind !== 'ALL') {
      where.kind = params.kind;
    }
    if (params.conversationId) {
      where.OR = [{ conversationId: params.conversationId }, { conversationId: null }];
    }

    const rows = await this.model.findMany({
      where,
      orderBy: { createdAt: 'asc' },
    });

    const active: typeof rows = [];
    for (const row of rows) {
      if (new Date(row.expiresAt).getTime() < now.getTime()) {
        await this.model.update({ where: { id: row.id }, data: { status: 'EXPIRED' } });
        continue;
      }
      active.push(row);
    }
    return active;
  }

  matchByClassQueries<T extends { payload?: unknown; summary?: string }>(
    plans: T[],
    classQueries: string[],
  ): { matched: T[]; unmatchedQueries: string[] } {
    const queries = classQueries.map((q) => q.trim()).filter(Boolean);
    if (queries.length === 0) return { matched: [], unmatchedQueries: [] };

    const matched: T[] = [];
    const seen = new Set<T>();
    const unmatchedQueries: string[] = [];

    for (const query of queries) {
      const hits = plans.filter((plan) => {
        const label = payloadClassLabel(plan.payload) || plan.summary;
        return classLabelMatches(label, query);
      });
      if (hits.length === 0) {
        unmatchedQueries.push(query);
        continue;
      }
      for (const hit of hits) {
        if (!seen.has(hit)) {
          seen.add(hit);
          matched.push(hit);
        }
      }
    }
    return { matched, unmatchedQueries };
  }
}
