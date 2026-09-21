import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../database/prisma.service';
import { EmailService } from '../../email/email.service';
import { TransfersService } from '../../transfers/transfers.service';
import { hasPrincipalAccess } from '../dto/permission.dto';
import { SchoolMapper } from '../domain/mappers/school.mapper';
import { SchoolDto } from '../dto/school.dto';

export const CLOSE_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class SchoolLifecycleService {
  private readonly logger = new Logger(SchoolLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly transfers: TransfersService,
    private readonly schoolMapper: SchoolMapper,
    @InjectQueue('school-lifecycle-queue') private readonly queue: Queue,
  ) {}

  async scheduleClose(
    schoolId: string,
    reason: string,
    actor: { userId: string; role: 'SCHOOL_OWNER' | 'SUPER_ADMIN' },
  ): Promise<SchoolDto> {
    const trimmed = (reason || '').trim();
    if (trimmed.length < 8) {
      throw new BadRequestException('Please provide a reason (at least 8 characters).');
    }

    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
      include: { branding: true },
    });
    if (!school) throw new BadRequestException('School not found');
    if (school.registrationStatus !== 'VERIFIED') {
      throw new BadRequestException('Only verified schools can be scheduled for close.');
    }
    if (school.lifecycleStatus === 'DEACTIVATED' || !school.isActive) {
      throw new BadRequestException('This school is already deactivated.');
    }
    if (school.lifecycleStatus === 'CLOSING') {
      throw new BadRequestException('A close is already scheduled for this school.');
    }

    const deactivatesAt = new Date(Date.now() + CLOSE_DELAY_MS);
    const updated = await this.prisma.school.update({
      where: { id: schoolId },
      data: {
        lifecycleStatus: 'CLOSING',
        isActive: true,
        deactivationReason: trimmed,
        deactivationRequestedAt: new Date(),
        deactivatesAt,
        deactivationRequestedByUserId: actor.userId,
        deactivationRequestedByRole: actor.role,
        deactivatedAt: null,
      },
      include: { branding: true, admins: { include: { user: true } } },
    });

    const delay = Math.max(deactivatesAt.getTime() - Date.now(), 1000);
    await this.queue.add(
      'apply-deactivation',
      { schoolId },
      { jobId: `apply-deactivation-${schoolId}`, delay, removeOnComplete: 50, attempts: 5 },
    );

    void this.notifyAdmins(updated, 'scheduled', trimmed, deactivatesAt);
    return this.schoolMapper.toDto(updated);
  }

  async cancelClose(schoolId: string): Promise<SchoolDto> {
    const school = await this.prisma.school.findUnique({ where: { id: schoolId } });
    if (!school) throw new BadRequestException('School not found');
    if (school.lifecycleStatus !== 'CLOSING') {
      throw new BadRequestException('This school is not scheduled to close.');
    }

    await this.queue.remove(`apply-deactivation-${schoolId}`).catch(() => undefined);

    const updated = await this.prisma.school.update({
      where: { id: schoolId },
      data: {
        lifecycleStatus: 'ACTIVE',
        isActive: true,
        deactivationReason: null,
        deactivationRequestedAt: null,
        deactivatesAt: null,
        deactivationRequestedByUserId: null,
        deactivationRequestedByRole: null,
      },
      include: { branding: true, admins: { include: { user: true } } },
    });

    void this.notifyAdmins(updated, 'cancelled');
    return this.schoolMapper.toDto(updated);
  }

  async applyDeactivation(schoolId: string): Promise<void> {
    const school = await this.prisma.school.findUnique({ where: { id: schoolId } });
    if (!school) return;
    if (school.lifecycleStatus !== 'CLOSING') return;

    await this.prisma.school.update({
      where: { id: schoolId },
      data: {
        lifecycleStatus: 'DEACTIVATED',
        isActive: false,
        deactivatedAt: new Date(),
      },
    });

    await this.queue.add(
      'issue-closure-tacs',
      { schoolId },
      { jobId: `issue-closure-tacs-${schoolId}-${Date.now()}`, attempts: 8, backoff: { type: 'exponential', delay: 30_000 } },
    );

    const full = await this.prisma.school.findUnique({
      where: { id: schoolId },
      include: { admins: { include: { user: true } } },
    });
    if (full) void this.notifyAdmins(full, 'deactivated', full.deactivationReason || undefined);
  }

  async issueClosureTacs(schoolId: string): Promise<void> {
    await this.transfers.issueClosureTacsForSchool(schoolId);
  }

  @Cron('0 * * * *')
  async applyOverdueCloses(): Promise<void> {
    const due = await this.prisma.school.findMany({
      where: {
        lifecycleStatus: 'CLOSING',
        deactivatesAt: { lte: new Date() },
      },
      select: { id: true },
    });
    for (const school of due) {
      try {
        await this.applyDeactivation(school.id);
      } catch (err) {
        this.logger.error(`Overdue deactivation failed for ${school.id}: ${err}`);
      }
    }
  }

  async reactivate(schoolId: string): Promise<SchoolDto> {
    const school = await this.prisma.school.findUnique({ where: { id: schoolId } });
    if (!school) throw new BadRequestException('School not found');
    if (school.lifecycleStatus !== 'DEACTIVATED' && school.isActive) {
      throw new BadRequestException('This school is already active.');
    }

    await this.queue.remove(`apply-deactivation-${schoolId}`).catch(() => undefined);

    const updated = await this.prisma.school.update({
      where: { id: schoolId },
      data: {
        lifecycleStatus: 'ACTIVE',
        isActive: true,
        deactivationReason: null,
        deactivationRequestedAt: null,
        deactivatesAt: null,
        deactivatedAt: null,
        deactivationRequestedByUserId: null,
        deactivationRequestedByRole: null,
      },
      include: { branding: true, admins: { include: { user: true } } },
    });

    void this.notifyAdmins(updated, 'reactivated');
    return this.schoolMapper.toDto(updated);
  }

  async assertOwnerOrPrincipal(userId: string, schoolId: string): Promise<void> {
    const admin = await this.prisma.schoolAdmin.findFirst({
      where: { userId, schoolId },
      select: { id: true, accessTier: true },
    });
    if (!admin || !hasPrincipalAccess(admin)) {
      throw new ForbiddenException('Only the school owner or a principal can do this.');
    }
  }

  private async notifyAdmins(
    school: { id: string; name: string; admins?: Array<{ user?: { email: string | null } | null; firstName: string; lastName: string }> },
    kind: 'scheduled' | 'cancelled' | 'deactivated' | 'reactivated',
    reason?: string,
    deactivatesAt?: Date,
  ) {
    try {
      const recipients = (school.admins || [])
        .map((a) => a.user?.email)
        .filter((e): e is string => !!e);
      await Promise.all(
        recipients.map((email) =>
          this.email.sendSchoolLifecycleEmail(email, school.name, kind, reason, deactivatesAt),
        ),
      );
    } catch (err) {
      this.logger.error(`Failed to send lifecycle email for ${school.id}: ${err}`);
    }
  }
}
