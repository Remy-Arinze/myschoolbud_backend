import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../database/prisma.service';
import { SchoolSettingsService } from '../school-settings/school-settings.service';
import * as webpush from 'web-push';
import { safeNoticeField } from './notification-text';

export type NotificationRole = 'SCHOOL_ADMIN' | 'TEACHER' | 'STUDENT' | 'SUPER_ADMIN';

export interface CreateNotificationInput {
  userId: string;
  schoolId?: string | null;
  role?: NotificationRole | string | null;
  type: string;
  title: string;
  subtitle?: string | null;
  body: string;
  link?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface InboxCreatedPayload {
  notification: {
    id: string;
    userId: string;
    schoolId: string | null;
    role: string | null;
    type: string;
    title: string;
    subtitle: string | null;
    body: string;
    link: string | null;
    metadata: unknown;
    readAt: string | null;
    createdAt: string;
  };
}

@Injectable()
export class NotificationInboxService {
  private readonly logger = new Logger(NotificationInboxService.name);
  private vapidConfigured = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly schoolSettingsService: SchoolSettingsService,
  ) {
    this.configureVapid();
  }

  private get db() {
    return this.prisma as any;
  }

  private configureVapid() {
    const publicKey = this.config.get<string>('VAPID_PUBLIC_KEY')?.trim();
    const privateKey = this.config.get<string>('VAPID_PRIVATE_KEY')?.trim();
    const subject = this.config.get<string>('VAPID_SUBJECT')?.trim() || 'mailto:support@myschoolbud.com';
    if (publicKey && privateKey) {
      try {
        webpush.setVapidDetails(subject, publicKey, privateKey);
        this.vapidConfigured = true;
      } catch (err: any) {
        this.logger.warn(`Failed to configure VAPID: ${err?.message || err}`);
      }
    } else {
      this.logger.warn('VAPID keys not set — web push disabled until VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY are configured');
    }
  }

  getVapidPublicKey(): string | null {
    return this.config.get<string>('VAPID_PUBLIC_KEY')?.trim() || null;
  }

  private mapEventTriggerKey(type: string): string | null {
    if (type === 'GRADE_PUBLISHED') return 'GRADE_PUBLISHED';
    if (type === 'ADMISSION_SUBMITTED') return 'ADMISSION_RECEIVED';
    if (type === 'TRANSFER_APPROVED') return 'TRANSFER_APPROVED';
    return null;
  }

  private isQuietHours(policy: {
    quietHoursStart?: string | null;
    quietHoursEnd?: string | null;
    quietHoursTimezone?: string | null;
  } | null): boolean {
    if (!policy?.quietHoursStart || !policy?.quietHoursEnd) return false;
    const tz = policy.quietHoursTimezone || 'Africa/Lagos';
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).formatToParts(new Date());
      const hh = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
      const mm = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
      const current = hh * 60 + mm;
      const [sh, sm] = policy.quietHoursStart.split(':').map(Number);
      const [eh, em] = policy.quietHoursEnd.split(':').map(Number);
      if ([sh, sm, eh, em].some((n) => Number.isNaN(n))) return false;
      const start = sh * 60 + sm;
      const end = eh * 60 + em;
      if (start === end) return false;
      if (start < end) return current >= start && current < end;
      return current >= start || current < end;
    } catch {
      return false;
    }
  }

  /**
   * Persist inbox rows, emit SSE inbox.created, and send web push.
   */
  async createAndFanOut(inputs: CreateNotificationInput | CreateNotificationInput[]) {
    const list = Array.isArray(inputs) ? inputs : [inputs];
    if (list.length === 0) return [];

    const created: any[] = [];
    for (const input of list) {
      if (!input.userId) continue;
      try {
        let policy: Awaited<ReturnType<SchoolSettingsService['getNotificationPolicy']>> | null = null;
        if (input.schoolId) {
          try {
            policy = await this.schoolSettingsService.getNotificationPolicy(input.schoolId);
          } catch {
            policy = null;
          }
        }
        const channels: string[] = policy?.enabledChannels?.length
          ? policy.enabledChannels
          : ['EMAIL', 'IN_APP', 'PUSH'];
        const triggers = (policy?.eventTriggers as Record<string, boolean> | null) ?? {};
        const triggerKey = this.mapEventTriggerKey(input.type);
        if (triggerKey && triggers[triggerKey] === false) {
          continue;
        }

        const persistInApp = channels.includes('IN_APP');
        const sendPush = channels.includes('PUSH') && !this.isQuietHours(policy);

        if (!persistInApp && !sendPush) {
          continue;
        }

        const title = safeNoticeField(input.title, 'School update');
        const subtitle = input.subtitle
          ? safeNoticeField(input.subtitle, '')
          : null;
        const body = safeNoticeField(
          input.body,
          'Open this notification in the app for what changed.',
        );
        if (title !== input.title.trim() || body !== input.body.trim() || (input.subtitle && subtitle !== input.subtitle.trim())) {
          this.logger.warn(`Dropped sensitive notification text for type ${input.type}`);
        }

        let row: any = null;
        if (persistInApp) {
          row = await this.db.inAppNotification.create({
            data: {
              userId: input.userId,
              schoolId: input.schoolId ?? null,
              role: input.role ?? null,
              type: input.type,
              title,
              subtitle: subtitle || null,
              body,
              link: input.link ?? null,
              metadata: input.metadata ?? undefined,
            },
          });
          created.push(row);

          const payload: InboxCreatedPayload = {
            notification: {
              id: row.id,
              userId: row.userId,
              schoolId: row.schoolId,
              role: row.role,
              type: row.type,
              title: row.title,
              subtitle: row.subtitle ?? null,
              body: row.body,
              link: row.link,
              metadata: row.metadata,
              readAt: row.readAt ? row.readAt.toISOString() : null,
              createdAt: row.createdAt.toISOString(),
            },
          };
          this.eventEmitter.emit('inbox.created', payload);
        }

        if (sendPush) {
          void this.sendPushToUser(input.userId, {
            title,
            body: subtitle || '',
            link: input.link,
            type: input.type,
            notificationId: row?.id ?? `skip-inapp-${Date.now()}`,
          });
        }
      } catch (err: any) {
        this.logger.error(`Failed to create notification for ${input.userId}: ${err?.message || err}`);
      }
    }
    return created;
  }

  async listForUser(
    userId: string,
    opts: { unreadOnly?: boolean; cursor?: string; limit?: number; schoolId?: string } = {},
  ) {
    const limit = Math.min(opts.limit ?? 30, 100);
    const where: any = { userId };
    if (opts.unreadOnly) where.readAt = null;
    if (opts.schoolId) where.schoolId = opts.schoolId;
    if (opts.cursor) {
      where.createdAt = { lt: new Date(opts.cursor) };
    }

    const items = await this.db.inAppNotification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
    });

    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore ? page[page.length - 1].createdAt.toISOString() : null;

    return {
      items: page.map((n: any) => ({
        id: n.id,
        userId: n.userId,
        schoolId: n.schoolId,
        role: n.role,
        type: n.type,
        title: n.title,
        subtitle: n.subtitle ?? null,
        body: n.body,
        link: n.link,
        metadata: n.metadata,
        readAt: n.readAt ? n.readAt.toISOString() : null,
        createdAt: n.createdAt.toISOString(),
      })),
      nextCursor,
      hasMore,
    };
  }

  async unreadCount(userId: string, schoolId?: string) {
    const where: any = { userId, readAt: null };
    if (schoolId) where.schoolId = schoolId;
    return this.db.inAppNotification.count({ where });
  }

  async markRead(userId: string, id: string) {
    const existing = await this.db.inAppNotification.findFirst({
      where: { id, userId },
    });
    if (!existing) return null;
    if (existing.readAt) return existing;
    return this.db.inAppNotification.update({
      where: { id },
      data: { readAt: new Date() },
    });
  }

  async markAllRead(userId: string, schoolId?: string) {
    const where: any = { userId, readAt: null };
    if (schoolId) where.schoolId = schoolId;
    const result = await this.db.inAppNotification.updateMany({
      where,
      data: { readAt: new Date() },
    });
    return { updated: result.count };
  }

  async savePushSubscription(
    userId: string,
    sub: { endpoint: string; keys: { p256dh: string; auth: string }; userAgent?: string },
  ) {
    return this.db.webPushSubscription.upsert({
      where: { endpoint: sub.endpoint },
      create: {
        userId,
        endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        userAgent: sub.userAgent ?? null,
      },
      update: {
        userId,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        userAgent: sub.userAgent ?? null,
      },
    });
  }

  async removePushSubscription(userId: string, endpoint: string) {
    await this.db.webPushSubscription.deleteMany({
      where: { userId, endpoint },
    });
    return { removed: true };
  }

  private async sendPushToUser(
    userId: string,
    payload: { title: string; body: string; link?: string | null; type: string; notificationId: string },
  ) {
    if (!this.vapidConfigured) return;

    const subs = await this.db.webPushSubscription.findMany({ where: { userId } });
    if (!subs.length) return;

    const body = JSON.stringify({
      title: payload.title,
      body: payload.body,
      link: payload.link || '/dashboard',
      type: payload.type,
      notificationId: payload.notificationId,
    });

    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          body,
        );
      } catch (err: any) {
        const status = err?.statusCode;
        if (status === 404 || status === 410) {
          await this.db.webPushSubscription.delete({ where: { id: sub.id } }).catch(() => null);
          this.logger.log(`Removed stale push subscription ${sub.id}`);
        } else {
          this.logger.warn(`Push failed for ${sub.id}: ${err?.message || err}`);
        }
      }
    }
  }

  // ─── Recipient resolvers ─────────────────────────────────

  async getSchoolAdminUserIds(schoolId: string): Promise<string[]> {
    const admins = await this.prisma.schoolAdmin.findMany({
      where: { schoolId },
      select: { userId: true },
    });
    return [...new Set(admins.map((a) => a.userId).filter(Boolean))];
  }

  async getTeacherUserId(teacherProfileId: string): Promise<string | null> {
    const t = await this.prisma.teacher.findUnique({
      where: { id: teacherProfileId },
      select: { userId: true },
    });
    return t?.userId ?? null;
  }

  async getStudentUserId(studentProfileId: string): Promise<string | null> {
    const s = await this.prisma.student.findUnique({
      where: { id: studentProfileId },
      select: { userId: true },
    });
    return s?.userId ?? null;
  }

  async getStudentUserIdsInClass(opts: {
    schoolId: string;
    classId?: string;
    classArmId?: string;
  }): Promise<string[]> {
    const enrollments = await this.prisma.enrollment.findMany({
      where: {
        schoolId: opts.schoolId,
        isActive: true,
        OR: [
          ...(opts.classId ? [{ classId: opts.classId }] : []),
          ...(opts.classArmId ? [{ classArmId: opts.classArmId }] : []),
        ],
      },
      select: { student: { select: { userId: true } } },
    });
    return [
      ...new Set(
        enrollments
          .map((e) => e.student?.userId)
          .filter((id): id is string => !!id),
      ),
    ];
  }

  async getTeacherUserIdsForClass(opts: {
    schoolId: string;
    classId?: string;
    classArmId?: string;
  }): Promise<string[]> {
    const where: any = {};
    if (opts.classArmId) where.classArmId = opts.classArmId;
    if (opts.classId) where.classId = opts.classId;
    if (!opts.classArmId && !opts.classId) return [];

    const assignments = await (this.prisma as any).classTeacher.findMany({
      where,
      select: { teacher: { select: { userId: true, schoolId: true } } },
    });
    return [
      ...new Set(
        assignments
          .filter((a: any) => a.teacher?.schoolId === opts.schoolId)
          .map((a: any) => a.teacher?.userId)
          .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0),
      ),
    ] as string[];
  }

  async getAllSchoolMemberUserIds(schoolId: string): Promise<{
    admins: string[];
    teachers: string[];
    students: string[];
  }> {
    const [admins, teachers, enrollments] = await Promise.all([
      this.prisma.schoolAdmin.findMany({ where: { schoolId }, select: { userId: true } }),
      this.prisma.teacher.findMany({ where: { schoolId }, select: { userId: true } }),
      this.prisma.enrollment.findMany({
        where: { schoolId, isActive: true },
        select: { student: { select: { userId: true } } },
      }),
    ]);
    return {
      admins: [...new Set(admins.map((a) => a.userId))],
      teachers: [...new Set(teachers.map((t) => t.userId))],
      students: [
        ...new Set(
          enrollments.map((e) => e.student?.userId).filter((id): id is string => !!id),
        ),
      ],
    };
  }
}
