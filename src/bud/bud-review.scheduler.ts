import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BudSubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { NotificationService } from '../notification/notification.service';

@Injectable()
export class BudReviewScheduler {
  private readonly logger = new Logger(BudReviewScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  @Cron('0 * * * *')
  async hourlyNudge() {
    const now = new Date();
    const hour = Number(
      new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Africa/Lagos' }).format(now),
    );
    const profiles = await this.prisma.budProfile.findMany({
      where: { reminderHour: hour },
      include: { student: { select: { id: true, userId: true, firstName: true } } },
    });
    for (const profile of profiles) {
      const sub = await this.prisma.budSubscription.findUnique({
        where: { studentId: profile.studentId },
      });
      if (
        !sub ||
        (sub.status !== BudSubscriptionStatus.ACTIVE && sub.status !== BudSubscriptionStatus.TRIAL)
      ) {
        continue;
      }
      try {
        await this.notifications.notifyUsers([profile.student.userId], {
          type: 'BUD_DAILY_REVIEW',
          title: `${profile.companionName}: ready to review?`,
          subtitle: 'Ready to review?',
          body: `Hey ${profile.student.firstName}, want to go over what you learnt today?`,
          link: '/dashboard/student/bud/review',
          role: 'STUDENT',
        });
      } catch (err: any) {
        this.logger.warn(`Bud nudge failed for ${profile.studentId}: ${err?.message || err}`);
      }
    }
  }
}
