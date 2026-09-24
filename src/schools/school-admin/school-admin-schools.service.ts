import {
  Injectable,
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service';
import { SchoolRepository } from '../domain/repositories/school.repository';
import { SchoolMapper } from '../domain/mappers/school.mapper';
import { SchoolDto } from '../dto/school.dto';
import {
  SchoolDashboardDto,
  SchoolDashboardChartsDto,
  DashboardStatsDto,
  GrowthTrendDataDto,
  WeeklyActivityDataDto,
  RecentStudentDto,
} from '../dto/dashboard.dto';
import { SchoolSetupProgressDto } from '../dto/setup-progress.dto';
import {
  StaffListResponseDto,
  StaffListItemDto,
  StaffListMetaDto,
  GetStaffListQueryDto,
} from '../dto/staff-list.dto';
import { UpdateSchoolDto } from '../dto/update-school.dto';
import { UserWithContext } from '../../auth/types/user-with-context.type';
import { CloudinaryService } from '../../storage/cloudinary/cloudinary.service';
import { EmailService } from '../../email/email.service';
import { randomBytes } from 'crypto';
import { AdminAccessTier, hasPrincipalAccess } from '../dto/permission.dto';
import { LiveStatusService } from '../../live-status/live-status.service';
import { Prisma, SessionStatus, TermStatus, SchemeOfWorkStatus } from '@prisma/client';
import { RedisService } from '../../common/redis/redis.service';
import { dashboardCacheKey } from '../../common/redis/dashboard-cache.events';
import { SchoolSettingsService } from '../../school-settings/school-settings.service';
import { PortalsService } from '../../portals/portals.service';
import * as dns from 'dns/promises';

/** Max staff records fetched per type (admins + teachers) to avoid unbounded memory; full server-side pagination would require a union query. */
const STAFF_FETCH_CAP = 500;

/**
 * Service for school admin operations on their own school
 * Handles viewing and updating their own school information
 */
@Injectable()
export class SchoolAdminSchoolsService {
  private readonly logger = new Logger(SchoolAdminSchoolsService.name);
  private readonly MAX_TOKEN_REQUESTS_PER_24H = 10;
  private readonly SUSPICIOUS_FAILURE_THRESHOLD = 5; // Alert after 5 failed attempts from same IP

  constructor(
    private readonly prisma: PrismaService,
    private readonly schoolRepository: SchoolRepository,
    private readonly schoolMapper: SchoolMapper,
    private readonly cloudinaryService: CloudinaryService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
    private readonly liveStatusService: LiveStatusService,
    private readonly redis: RedisService,
    private readonly schoolSettingsService: SchoolSettingsService,
    private readonly portals: PortalsService,
  ) { }

  private async assertPaidPortalFeature(schoolId: string): Promise<void> {
    const sub = await this.prisma.subscription.findUnique({
      where: { schoolId },
      select: { tier: true, isActive: true },
    });
    const tier = sub?.tier || 'FREE';
    if (tier !== 'PRO_PLUS' && tier !== 'CUSTOM') {
      throw new ForbiddenException('Custom domains and hiding the platform mark require Pro Plus or a custom plan.');
    }
  }

  /**
   * Get school admin's own school
   */
  async getMySchool(
    user: UserWithContext
  ): Promise<
    SchoolDto & {
      currentAdmin?: { id: string; role: string; accessTier: AdminAccessTier };
    }
  > {
    const schoolId = user.currentSchoolId;
    const profileId = user.currentProfileId;

    if (!schoolId) {
      throw new BadRequestException('You are not associated with any school');
    }

    const [completeSchool, teachersCount, studentsCount, adminRow] = await Promise.all([
      this.prisma.school.findUnique({
        where: { id: schoolId },
        include: { branding: true },
      }),
      this.prisma.teacher.count({ where: { schoolId } }),
      this.prisma.enrollment.count({ where: { schoolId, isActive: true } }),
      profileId
        ? this.prisma.schoolAdmin.findFirst({
            where: { id: profileId, schoolId },
            select: { id: true, role: true, accessTier: true },
          })
        : Promise.resolve(null),
    ]);

    if (!completeSchool) {
      throw new BadRequestException('School not found');
    }

    const schoolDto = this.schoolMapper.toDto(completeSchool, {
      teachersCount,
      studentsCount,
    });

    const runtimePolicies = await this.schoolSettingsService.getRuntimePolicies(completeSchool.id);

    // accessTier rides along so the shell never has to guess authority from the
    // title while the permissions request is still in flight.
    const currentAdmin = adminRow
      ? { id: adminRow.id, role: adminRow.role, accessTier: adminRow.accessTier }
      : undefined;

    const portalUrl = this.portals.buildPortalUrl(completeSchool);
    return { ...schoolDto, portalUrl, currentAdmin, runtimePolicies };
  }

  async updateBranding(
    user: UserWithContext,
    body: {
      accentColor?: string | null;
      loginTagline?: string | null;
      hidePlatformMark?: boolean;
    },
  ) {
    const schoolId = user.currentSchoolId;
    if (!schoolId) throw new BadRequestException('You are not associated with any school');

    if (body.hidePlatformMark) {
      await this.assertPaidPortalFeature(schoolId);
    }

    if (body.accentColor) {
      const hex = body.accentColor.trim();
      if (!/^#([0-9a-fA-F]{6})$/.test(hex)) {
        throw new BadRequestException('Accent color must be a 6-digit hex value, e.g. #0B3D91');
      }
    }

    const branding = await this.prisma.schoolBranding.upsert({
      where: { schoolId },
      create: {
        schoolId,
        accentColor: body.accentColor ?? null,
        loginTagline: body.loginTagline ?? null,
        hidePlatformMark: !!body.hidePlatformMark,
      },
      update: {
        ...(body.accentColor !== undefined ? { accentColor: body.accentColor } : {}),
        ...(body.loginTagline !== undefined ? { loginTagline: body.loginTagline } : {}),
        ...(body.hidePlatformMark !== undefined ? { hidePlatformMark: body.hidePlatformMark } : {}),
      },
    });
    return branding;
  }

  async uploadFavicon(user: UserWithContext, file: Express.Multer.File) {
    const schoolId = user.currentSchoolId;
    if (!schoolId) throw new BadRequestException('You are not associated with any school');
    if (!file) throw new BadRequestException('No file provided');
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/x-icon', 'image/vnd.microsoft.icon'];
    if (!allowedMimeTypes.includes(file.mimetype)) {
      throw new BadRequestException('Invalid file type for favicon');
    }
    const { url } = await this.cloudinaryService.uploadImage(
      file,
      `schools/${schoolId}/favicon`,
      `school-${schoolId}-favicon`,
    );
    return this.prisma.schoolBranding.upsert({
      where: { schoolId },
      create: { schoolId, faviconUrl: url },
      update: { faviconUrl: url },
    });
  }

  async requestCustomDomain(user: UserWithContext, host: string) {
    const schoolId = user.currentSchoolId;
    if (!schoolId) throw new BadRequestException('You are not associated with any school');
    await this.assertPaidPortalFeature(schoolId);

    const clean = host.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').split(':')[0];
    if (!clean || clean.includes(' ') || !clean.includes('.')) {
      throw new BadRequestException('Enter a valid hostname such as portal.yourschool.edu.ng');
    }
    const taken = await this.prisma.school.findFirst({
      where: { customDomain: clean, NOT: { id: schoolId } },
    });
    if (taken) throw new BadRequestException('That domain is already in use.');

    const txt = `msb-verify=${randomBytes(16).toString('hex')}`;
    const school = await this.prisma.school.update({
      where: { id: schoolId },
      data: {
        customDomain: clean,
        customDomainStatus: 'PENDING',
        customDomainTxt: txt,
        customDomainVerifiedAt: null,
      },
    });
    return {
      customDomain: school.customDomain,
      customDomainStatus: school.customDomainStatus,
      txtRecord: txt,
      cnameTarget: 'cname.myschoolbud.com',
    };
  }

  async verifyCustomDomain(user: UserWithContext) {
    const schoolId = user.currentSchoolId;
    if (!schoolId) throw new BadRequestException('You are not associated with any school');
    const school = await this.prisma.school.findUnique({ where: { id: schoolId } });
    if (!school?.customDomain || !school.customDomainTxt) {
      throw new BadRequestException('No custom domain is pending verification.');
    }

    await this.prisma.school.update({
      where: { id: schoolId },
      data: { customDomainStatus: 'VERIFYING' },
    });

    try {
      const records = await dns.resolveTxt(school.customDomain);
      const flat = records.flat().join(' ');
      if (!flat.includes(school.customDomainTxt)) {
        await this.prisma.school.update({
          where: { id: schoolId },
          data: { customDomainStatus: 'FAILED' },
        });
        throw new BadRequestException('TXT record not found yet. Add the verification record and try again.');
      }
      const updated = await this.prisma.school.update({
        where: { id: schoolId },
        data: {
          customDomainStatus: 'ACTIVE',
          customDomainVerifiedAt: new Date(),
        },
      });
      return {
        customDomain: updated.customDomain,
        customDomainStatus: updated.customDomainStatus,
      };
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      await this.prisma.school.update({
        where: { id: schoolId },
        data: { customDomainStatus: 'FAILED' },
      });
      throw new BadRequestException('Could not verify DNS yet. Check the CNAME and TXT records.');
    }
  }

  /**
   * Overview stats + recent students. Charts load via getDashboardCharts.
   */
  async getDashboard(user: UserWithContext, schoolType?: string): Promise<SchoolDashboardDto> {
    const schoolId = user.currentSchoolId;
    if (!schoolId) {
      throw new BadRequestException('You are not associated with any school');
    }

    const cacheKey = dashboardCacheKey('summary', schoolId, schoolType);
    const cached = await this.redis.getJson<SchoolDashboardDto>(cacheKey);
    if (cached) return cached;

    const now = new Date();
    const lastMonth = new Date(now);
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    const typeFilter = this.enrollmentSchoolTypeSql(schoolId, schoolType);
    const classTypeFilter = schoolType
      ? Prisma.sql`AND type = ${schoolType}`
      : Prisma.empty;

    const [enrollmentPair, teacherPair, classPair, admissionPair, recentEnrollments] =
      await Promise.all([
        this.prisma.$queryRaw<Array<{ current: number; previous: number }>>`
          SELECT
            COUNT(*) FILTER (WHERE e."isActive" = true)::int AS current,
            COUNT(*) FILTER (WHERE e."isActive" = true AND e."createdAt" <= ${lastMonth})::int AS previous
          FROM "Enrollment" e
          WHERE e."schoolId" = ${schoolId}
          ${typeFilter}
        `,
        this.prisma.$queryRaw<Array<{ current: number; previous: number }>>`
          SELECT
            COUNT(*)::int AS current,
            COUNT(*) FILTER (WHERE t."createdAt" <= ${lastMonth})::int AS previous
          FROM "Teacher" t
          WHERE t."schoolId" = ${schoolId}
        `,
        this.prisma.$queryRaw<Array<{ current: number; previous: number }>>`
          SELECT
            COUNT(*) FILTER (WHERE c."isActive" = true)::int AS current,
            COUNT(*) FILTER (WHERE c."isActive" = true AND c."createdAt" <= ${lastMonth})::int AS previous
          FROM "Class" c
          WHERE c."schoolId" = ${schoolId}
          ${classTypeFilter}
        `,
        Promise.resolve(
          this.prisma.$queryRaw<Array<{ current: number; previous: number }>>`
            SELECT
              COUNT(*)::int AS current,
              COUNT(*) FILTER (WHERE a."createdAt" <= ${lastMonth})::int AS previous
            FROM "AdmissionApplication" a
            WHERE a."schoolId" = ${schoolId}
              AND a.status = 'PENDING'::"AdmissionStatus"
          `
        ).catch(() => [{ current: 0, previous: 0 }]),
        this.prisma.enrollment.findMany({
          where: {
            schoolId,
            isActive: true,
            ...(schoolType
              ? { class: { type: schoolType as any, isActive: true } }
              : {}),
          },
          include: {
            student: {
              select: {
                id: true,
                firstName: true,
                middleName: true,
                lastName: true,
                profileImage: true,
                uid: true,
                publicId: true,
              },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: 5,
        }),
      ]);

    const enrollments = enrollmentPair[0] ?? { current: 0, previous: 0 };
    const teachers = teacherPair[0] ?? { current: 0, previous: 0 };
    const courses = classPair[0] ?? { current: 0, previous: 0 };
    const admissions = admissionPair[0] ?? { current: 0, previous: 0 };

    const stats: DashboardStatsDto = {
      totalStudents: enrollments.current,
      studentsChange: this.percentChange(enrollments.current, enrollments.previous),
      totalTeachers: teachers.current,
      teachersChange: this.percentChange(teachers.current, teachers.previous),
      activeCourses: courses.current,
      coursesChange: this.percentChange(courses.current, courses.previous),
      pendingAdmissions: admissions.current,
      pendingAdmissionsChange: admissions.current - admissions.previous,
    };

    const recentStudents: RecentStudentDto[] = recentEnrollments.map((enrollment) => ({
      id: enrollment.student.id,
      name: `${enrollment.student.firstName} ${enrollment.student.middleName ? `${enrollment.student.middleName} ` : ''}${enrollment.student.lastName}`.trim(),
      profileImage: enrollment.student.profileImage ?? null,
      classLevel: enrollment.classLevel || 'N/A',
      admissionNumber: enrollment.student.uid || enrollment.student.publicId || 'N/A',
      status: enrollment.isActive ? 'active' : 'inactive',
      createdAt: enrollment.createdAt.toISOString().split('T')[0],
    }));

    const payload: SchoolDashboardDto = { stats, recentStudents };
    await this.redis.setJson(cacheKey, payload);
    return payload;
  }

  /**
   * Growth / distribution / weekly charts — loaded after the overview stats.
   */
  async getDashboardCharts(
    user: UserWithContext,
    schoolType?: string
  ): Promise<SchoolDashboardChartsDto> {
    const schoolId = user.currentSchoolId;
    if (!schoolId) {
      throw new BadRequestException('You are not associated with any school');
    }

    const cacheKey = dashboardCacheKey('charts', schoolId, schoolType);
    const cached = await this.redis.getJson<SchoolDashboardChartsDto>(cacheKey);
    if (cached) return cached;

    const now = new Date();
    const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);
    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() - 6);
    weekStart.setHours(0, 0, 0, 0);

    const typeFilter = this.enrollmentSchoolTypeSql(schoolId, schoolType);
    const classTypeFilter = schoolType
      ? Prisma.sql`AND type = ${schoolType}`
      : Prisma.empty;

    const [enrollmentMonths, teacherMonths, classMonths, enrollmentDays, distributionRows] =
      await Promise.all([
        this.prisma.$queryRaw<Array<{ month: Date; count: number }>>`
          SELECT date_trunc('month', timezone('Africa/Lagos', e."createdAt")) AS month,
                 COUNT(*)::int AS count
          FROM "Enrollment" e
          WHERE e."schoolId" = ${schoolId}
            AND e."createdAt" >= ${sixMonthsAgo}
          ${typeFilter}
          GROUP BY 1
        `,
        this.prisma.$queryRaw<Array<{ month: Date; count: number }>>`
          SELECT date_trunc('month', timezone('Africa/Lagos', t."createdAt")) AS month,
                 COUNT(*)::int AS count
          FROM "Teacher" t
          WHERE t."schoolId" = ${schoolId}
            AND t."createdAt" >= ${sixMonthsAgo}
          GROUP BY 1
        `,
        this.prisma.$queryRaw<Array<{ month: Date; count: number }>>`
          SELECT date_trunc('month', timezone('Africa/Lagos', c."createdAt")) AS month,
                 COUNT(*)::int AS count
          FROM "Class" c
          WHERE c."schoolId" = ${schoolId}
            AND c."isActive" = true
            AND c."createdAt" >= ${sixMonthsAgo}
          ${classTypeFilter}
          GROUP BY 1
        `,
        this.prisma.$queryRaw<Array<{ day: Date; count: number }>>`
          SELECT date_trunc('day', timezone('Africa/Lagos', e."createdAt")) AS day,
                 COUNT(*)::int AS count
          FROM "Enrollment" e
          WHERE e."schoolId" = ${schoolId}
            AND e."createdAt" >= ${weekStart}
          ${typeFilter}
          GROUP BY 1
        `,
        this.prisma.$queryRaw<Array<{ name: string; students: number }>>`
          SELECT COALESCE(NULLIF(trim(e."classLevel"), ''), 'Unassigned') AS name,
                 COUNT(*)::int AS students
          FROM "Enrollment" e
          WHERE e."schoolId" = ${schoolId}
            AND e."isActive" = true
          ${typeFilter}
          GROUP BY 1
          ORDER BY 1
        `,
      ]);

    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const enrollmentMonthMap = this.monthCountMap(enrollmentMonths);
    const teacherMonthMap = this.monthCountMap(teacherMonths);
    const classMonthMap = this.monthCountMap(classMonths);

    const growthTrends: GrowthTrendDataDto[] = [];
    for (let i = 5; i >= 0; i--) {
      const monthDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = this.monthKey(monthDate);
      growthTrends.push({
        name: monthNames[monthDate.getMonth()],
        students: enrollmentMonthMap.get(key) ?? 0,
        teachers: teacherMonthMap.get(key) ?? 0,
        courses: classMonthMap.get(key) ?? 0,
      });
    }

    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dayMap = new Map<string, number>();
    for (const row of enrollmentDays) {
      dayMap.set(this.dayKey(new Date(row.day)), row.count);
    }

    const weeklyActivity: WeeklyActivityDataDto[] = [];
    for (let i = 6; i >= 0; i--) {
      const dayDate = new Date(now);
      dayDate.setDate(dayDate.getDate() - i);
      dayDate.setHours(0, 0, 0, 0);
      weeklyActivity.push({
        name: dayNames[dayDate.getDay()],
        admissions: dayMap.get(this.dayKey(dayDate)) ?? 0,
        transfers: 0,
      });
    }

    const payload: SchoolDashboardChartsDto = {
      growthTrends,
      studentDistribution: distributionRows.map((row) => ({
        name: row.name,
        students: row.students,
      })),
      weeklyActivity,
    };
    await this.redis.setJson(cacheKey, payload);
    return payload;
  }

  private enrollmentSchoolTypeSql(schoolId: string, schoolType?: string): Prisma.Sql {
    if (!schoolType) return Prisma.empty;
    return Prisma.sql`AND (
      e."classId" IN (
        SELECT c.id FROM "Class" c
        WHERE c."schoolId" = ${schoolId} AND c.type = ${schoolType} AND c."isActive" = true
      )
      OR e."classLevel" IN (
        SELECT c.name FROM "Class" c
        WHERE c."schoolId" = ${schoolId} AND c.type = ${schoolType} AND c."isActive" = true
      )
    )`;
  }

  private async resolveSetupClasses(
    schoolId: string,
    schoolType?: string
  ): Promise<{ classCount: number; suggestedClassId: string | null }> {
    if (schoolType === 'TERTIARY') {
      const first = await this.prisma.class.findFirst({
        where: { schoolId, isActive: true, type: 'TERTIARY' },
        select: { id: true },
        orderBy: { name: 'asc' },
      });
      const classCount = first
        ? await this.prisma.class.count({
            where: { schoolId, isActive: true, type: 'TERTIARY' },
          })
        : 0;
      return { classCount, suggestedClassId: first?.id ?? null };
    }

    const armWhere = {
      isActive: true,
      classLevel: {
        schoolId,
        ...(schoolType === 'PRIMARY' || schoolType === 'SECONDARY'
          ? { type: schoolType, isActive: true }
          : { isActive: true }),
      },
    };

    const firstArm = await this.prisma.classArm.findFirst({
      where: armWhere,
      select: { id: true },
      orderBy: [{ classLevel: { level: 'asc' } }, { name: 'asc' }],
    });
    if (firstArm) {
      const classCount = await this.prisma.classArm.count({ where: armWhere });
      return { classCount, suggestedClassId: firstArm.id };
    }

    if (schoolType === 'PRIMARY' || schoolType === 'SECONDARY') {
      return { classCount: 0, suggestedClassId: null };
    }

    const firstClass = await this.prisma.class.findFirst({
      where: { schoolId, isActive: true },
      select: { id: true },
      orderBy: { name: 'asc' },
    });
    const classCount = firstClass
      ? await this.prisma.class.count({ where: { schoolId, isActive: true } })
      : 0;
    return { classCount, suggestedClassId: firstClass?.id ?? null };
  }

  private percentChange(current: number, previous: number): number {
    if (previous > 0) return Math.round(((current - previous) / previous) * 100);
    return current > 0 ? 100 : 0;
  }

  private monthKey(date: Date): string {
    return `${date.getFullYear()}-${date.getMonth()}`;
  }

  private dayKey(date: Date): string {
    return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  }

  private monthCountMap(rows: Array<{ month: Date; count: number }>): Map<string, number> {
    const map = new Map<string, number>();
    for (const row of rows) {
      map.set(this.monthKey(new Date(row.month)), row.count);
    }
    return map;
  }

  /**
   * Lightweight checklist flags for school-admin onboarding guidance.
   * Session/term is loaded first (termId is needed); remaining counts run in parallel.
   */
  async getSetupProgress(
    user: UserWithContext,
    schoolType?: string
  ): Promise<SchoolSetupProgressDto> {
    const schoolId = user.currentSchoolId;
    if (!schoolId) {
      throw new BadRequestException('You are not associated with any school');
    }

    const session = await this.prisma.academicSession.findFirst({
      where: {
        schoolId,
        status: SessionStatus.ACTIVE,
        schoolType: schoolType || null,
      },
      include: {
        terms: {
          where: { status: TermStatus.ACTIVE },
          take: 1,
        },
      },
    });

    const hasActiveSession = !!session && session.terms.length > 0;
    const activeTerm = session?.terms[0] as
      | {
          id: string;
          midtermStart?: Date | null;
          midtermEnd?: Date | null;
          examStart?: Date | null;
          examEnd?: Date | null;
        }
      | undefined;
    const termId = activeTerm?.id;

    const hasMidtermDates = !!(activeTerm?.midtermStart && activeTerm?.midtermEnd);
    const hasExamDates = !!(activeTerm?.examStart && activeTerm?.examEnd);

    const [
      holidayCount,
      subjectCount,
      teacherCount,
      timetableCount,
      schemeCount,
      classInfo,
      studentCount,
    ] = await Promise.all([
      this.prisma.event.count({
        where: {
          schoolId,
          type: 'HOLIDAY',
          ...(schoolType
            ? {
                OR: [{ schoolType }, { schoolType: null }],
              }
            : {}),
        },
      }),
      this.prisma.subject.count({
        where: {
          schoolId,
          isActive: true,
          ...(schoolType
            ? { OR: [{ schoolType }, { schoolType: null }] }
            : {}),
        },
      }),
      this.prisma.teacher.count({ where: { schoolId } }),
      termId
        ? this.prisma.timetablePeriod.count({
            where: {
              termId,
              type: 'LESSON',
              ...(schoolType
                ? {
                    OR: [
                      { class: { type: schoolType as any } },
                      { classArm: { classLevel: { type: schoolType as any } } },
                      { course: { type: schoolType as any } },
                    ],
                  }
                : {}),
            },
          })
        : Promise.resolve(0),
      this.prisma.schemeOfWork.count({
        where: {
          schoolId,
          status: SchemeOfWorkStatus.PUBLISHED,
          ...(termId ? { termId } : {}),
        },
      }),
      this.resolveSetupClasses(schoolId, schoolType),
      this.prisma.enrollment.count({
        where: {
          schoolId,
          isActive: true,
          ...(schoolType
            ? { class: { type: schoolType as any, isActive: true } }
            : {}),
        },
      }),
    ]);

    const hasHolidays = holidayCount > 0;
    const { classCount, suggestedClassId } = classInfo;


    const flags = {
      hasActiveSession,
      hasSubjects: subjectCount > 0,
      hasClasses: classCount > 0,
      hasStaff: teacherCount > 0,
      hasTimetable: timetableCount > 0,
      hasCurriculum: schemeCount > 0,
      hasStudents: studentCount > 0,
      hasMidtermDates,
      hasExamDates,
      hasHolidays,
    };

    const isFoundationComplete =
      flags.hasSubjects && flags.hasClasses && flags.hasStaff && flags.hasStudents;

    // One-time foundation steps drop out of the checklist once done so later terms
    // only surface term-scoped work (session, timetable, curriculum, dates, holidays).
    const visibleFlags = isFoundationComplete
      ? {
          hasActiveSession: flags.hasActiveSession,
          hasTimetable: flags.hasTimetable,
          hasCurriculum: flags.hasCurriculum,
          hasMidtermDates: flags.hasMidtermDates,
          hasExamDates: flags.hasExamDates,
          hasHolidays: flags.hasHolidays,
        }
      : flags;

    const completedCount = Object.values(visibleFlags).filter(Boolean).length;
    const totalCount = Object.keys(visibleFlags).length;

    return {
      ...flags,
      isFoundationComplete,
      completedCount,
      totalCount,
      suggestedClassId,
    };
  }

  /**
   * Get paginated staff list with search and filtering
   */
  async getStaffList(
    user: UserWithContext,
    query: GetStaffListQueryDto
  ): Promise<StaffListResponseDto> {
    const schoolId = user.currentSchoolId;

    if (!schoolId) {
      throw new BadRequestException('You are not associated with any school');
    }

    const page = Math.max(1, query.page || 1);
    const limit = Math.min(100, Math.max(1, query.limit || 10)); // Max 100 items per page
    const skip = (page - 1) * limit;
    const search = query.search?.trim() || '';
    const roleFilter = query.role?.trim() || '';
    const schoolType = query.schoolType?.trim();

    // Note: schoolType is kept for potential future filtering but doesn't restrict teacher visibility
    // Teachers are shown regardless of class assignment to ensure newly imported teachers are visible

    // Build search conditions for both admins and teachers
    const searchCondition = search
      ? {
        OR: [
          { firstName: { contains: search, mode: 'insensitive' as const } },
          { lastName: { contains: search, mode: 'insensitive' as const } },
          { email: { contains: search, mode: 'insensitive' as const } },
        ],
      }
      : {};

    // Build role filter condition
    const isTeacherFilter = roleFilter === 'Teacher';
    const isSpecificRoleFilter = roleFilter && roleFilter !== 'All' && roleFilter !== 'Teacher';

    // Build teacher filter condition - include schoolType filtering if provided
    const teacherWhereCondition: any = {
      schoolId,
      ...searchCondition,
      ...(isSpecificRoleFilter ? { id: { in: [] } } : {}), // Exclude teachers if filtering by admin role
    };

    // If schoolType is provided, filter teachers by:
    // - For PRIMARY: Teachers assigned to classes/classArms of that type
    // - For SECONDARY/TERTIARY: Teachers assigned to subjects of that type OR form teachers for classes/classArms of that type
    // - All: Unassigned teachers (newly imported)
    let teacherIdsForSchoolType: string[] | undefined;
    if (schoolType) {
      const teacherIdSets = new Set<string>();

      // Get all Class records of the specified school type (for backward compatibility)
      const classesOfType = await this.prisma.class.findMany({
        where: {
          schoolId,
          type: schoolType,
          isActive: true,
        },
        select: { id: true },
      });
      const classIds = classesOfType.map((c) => c.id);

      // Also get ClassArm IDs for PRIMARY/SECONDARY (new ClassLevel + ClassArm system)
      let classArmIds: string[] = [];
      if (schoolType === 'PRIMARY' || schoolType === 'SECONDARY') {
        const classLevels = await this.prisma.classLevel.findMany({
          where: {
            schoolId,
            type: schoolType,
            isActive: true,
          },
          include: {
            classArms: {
              where: { isActive: true },
              select: { id: true },
            },
          },
        });
        classArmIds = classLevels.flatMap((cl) => cl.classArms.map((arm) => arm.id));
      }

      // Get teachers assigned to Classes (backward compatibility)
      if (classIds.length > 0) {
        if (schoolType === 'PRIMARY') {
          // For PRIMARY: Include all teachers assigned to primary classes
          const classTeachers = await this.prisma.classTeacher.findMany({
            where: {
              classId: { in: classIds },
            },
            select: { teacherId: true },
            distinct: ['teacherId'],
          });
          classTeachers.forEach((ct) => teacherIdSets.add(ct.teacherId));
        } else {
          // For SECONDARY/TERTIARY: Include form teachers (isPrimary: true) for classes of that type
          const formTeachers = await this.prisma.classTeacher.findMany({
            where: {
              classId: { in: classIds },
              isPrimary: true,
            },
            select: { teacherId: true },
            distinct: ['teacherId'],
          });
          formTeachers.forEach((ft) => teacherIdSets.add(ft.teacherId));
        }
      }

      // Get teachers assigned to ClassArms (new system for PRIMARY/SECONDARY)
      if (classArmIds.length > 0) {
        if (schoolType === 'PRIMARY') {
          // For PRIMARY: Include all teachers assigned to primary class arms
          const classArmTeachers = await this.prisma.classTeacher.findMany({
            where: {
              classArmId: { in: classArmIds },
            },
            select: { teacherId: true },
            distinct: ['teacherId'],
          });
          classArmTeachers.forEach((ct) => teacherIdSets.add(ct.teacherId));
        } else if (schoolType === 'SECONDARY') {
          // For SECONDARY: Include form teachers for class arms
          const formTeachers = await this.prisma.classTeacher.findMany({
            where: {
              classArmId: { in: classArmIds },
              isPrimary: true,
            },
            select: { teacherId: true },
            distinct: ['teacherId'],
          });
          formTeachers.forEach((ft) => teacherIdSets.add(ft.teacherId));
        }
      }

      // For SECONDARY/TERTIARY: Also include teachers assigned to subjects of that schoolType
      if (schoolType === 'SECONDARY' || schoolType === 'TERTIARY') {
        const subjectsOfType = await this.prisma.subject.findMany({
          where: {
            schoolId,
            schoolType,
            isActive: true,
          },
          select: { id: true },
        });
        const subjectIds = subjectsOfType.map((s) => s.id);

        if (subjectIds.length > 0) {
          const subjectTeachers = await this.prisma.subjectTeacher.findMany({
            where: {
              subjectId: { in: subjectIds },
            },
            select: { teacherId: true },
            distinct: ['teacherId'],
          });
          subjectTeachers.forEach((st) => teacherIdSets.add(st.teacherId));
        }
      }

      teacherIdsForSchoolType = Array.from(teacherIdSets);
    }

    // Fetch staff with cap (bounded) to avoid unbounded memory for large schools
    const [allAdmins, allTeachers] = await Promise.all([
      this.prisma.schoolAdmin.findMany({
        where: {
          schoolId,
          ...searchCondition,
          ...(isSpecificRoleFilter
            ? { role: { equals: roleFilter, mode: 'insensitive' as const } }
            : {}),
          // Filter admins by schoolType: show admins scoped to this type OR school-wide admins (null)
          ...(schoolType
            ? {
              OR: [
                { schoolType: schoolType },
                { schoolType: null },
              ],
            }
            : {}),
          // Exclude School Owner from general staff list
          role: {
            not: 'School Owner',
          },
        },
        include: { user: true },
        orderBy: { createdAt: 'desc' },
        take: STAFF_FETCH_CAP,
      }),
      this.prisma.teacher.findMany({
        where: teacherWhereCondition,
        include: {
          user: true,
          classTeachers: {
            include: {
              class: {
                select: {
                  id: true,
                  name: true,
                  type: true,
                },
              },
              classArm: {
                include: {
                  classLevel: {
                    select: {
                      id: true,
                      name: true,
                      type: true,
                    },
                  },
                },
              },
            },
          },
          subjectTeachers: {
            include: {
              subject: {
                select: {
                  id: true,
                  name: true,
                  schoolType: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: STAFF_FETCH_CAP,
      }),
    ]);

    // Filter teachers by schoolType if provided
    // Include teachers who:
    // 1. Have a matching schoolType field, OR
    // 2. Are assigned to classes/classArms/subjects of the specified schoolType, OR
    // 3. Have no schoolType AND no assignments at all (newly imported legacy teachers)
    let filteredTeachers = allTeachers;
    if (schoolType && teacherIdsForSchoolType !== undefined) {
      filteredTeachers = allTeachers.filter((teacher) => {
        // High priority: Check the explicit schoolType field on the teacher
        if (teacher.schoolType === schoolType) {
          return true;
        }

        // If teacher has a different schoolType, exclude them even if assignments are weird
        if (teacher.schoolType && teacher.schoolType !== schoolType) {
          return false;
        }

        // Fallback for legacy/imported teachers: Check class assignments (both Class and ClassArm)
        const hasNoClassAssignments = !teacher.classTeachers || teacher.classTeachers.length === 0;
        const hasNoSubjectAssignments =
          !teacher.subjectTeachers || teacher.subjectTeachers.length === 0;

        // If teacher has no schoolType AND no assignments at all, include them (newly imported or legacy)
        if (!teacher.schoolType && hasNoClassAssignments && hasNoSubjectAssignments) {
          return true;
        }

        // Check if teacher is in the list of teachers derived from assignments for this schoolType
        return teacherIdsForSchoolType!.includes(teacher.id);
      });
    }

    // Combine and map to DTO format
    const allStaff: StaffListItemDto[] = [
      ...allAdmins.map((admin) => ({
        id: admin.id,
        type: 'admin' as const,
        firstName: admin.firstName,
        lastName: admin.lastName,
        email: admin.email,
        phone: admin.phone,
        role: admin.role,
        accessTier: admin.accessTier,
        subject: null,
        employeeId: null,
        isTemporary: false,
        status: (admin.user?.accountStatus === 'ACTIVE' ? 'active' : 'inactive') as
          | 'active'
          | 'inactive',
        accountStatus: (admin.user?.accountStatus || 'SHADOW') as
          | 'SHADOW'
          | 'ACTIVE'
          | 'SUSPENDED'
          | 'ARCHIVED',
        profileImage: admin.profileImage,
        schoolType: admin.schoolType || null,
        createdAt: admin.createdAt,
      })),
      ...filteredTeachers.map((teacher) => {
        // Get subject names from SubjectTeacher relationships, fallback to legacy subject field
        const subjectNames =
          teacher.subjectTeachers?.map((st: any) => st.subject?.name).filter(Boolean) || [];
        const displaySubject = subjectNames.length > 0 ? subjectNames.join(', ') : teacher.subject;

        // Extract primary class assignment for PRIMARY teachers
        let assignedClass: { id: string; name: string } | null = null;
        const classTeachers = teacher.classTeachers || [];
        // Extract assignment if we have class teachers
        const primaryAssignment: any =
          classTeachers.find((ct: any) => ct.isPrimary && (ct.classArmId || ct.classId)) ||
          classTeachers.find((ct: any) => ct.classArmId || ct.classId);

        if (primaryAssignment) {
          if (primaryAssignment.classArm && primaryAssignment.classArm.classLevel) {
            assignedClass = {
              id: primaryAssignment.classArmId,
              name: `${primaryAssignment.classArm.classLevel.name} ${primaryAssignment.classArm.name}`,
            };
          } else if (primaryAssignment.class) {
            assignedClass = {
              id: primaryAssignment.classId,
              name: primaryAssignment.class.name || 'Unknown',
            };
          }
        }

        return {
          id: teacher.id,
          type: 'teacher' as const,
          firstName: teacher.firstName,
          lastName: teacher.lastName,
          email: teacher.email,
          phone: teacher.phone,
          role: 'Teacher',
          // Teachers are not admins, so they hold no authority tier at all.
          accessTier: null,
          subject: displaySubject,
          employeeId: teacher.employeeId,
          isTemporary: teacher.isTemporary,
          status: (teacher.user?.accountStatus === 'ACTIVE' ? 'active' : 'inactive') as
            | 'active'
            | 'inactive',
          accountStatus: (teacher.user?.accountStatus || 'SHADOW') as
            | 'SHADOW'
            | 'ACTIVE'
            | 'SUSPENDED'
            | 'ARCHIVED',
          profileImage: teacher.profileImage,
          schoolType: teacher.schoolType || null,
          assignedClass,
          createdAt: teacher.createdAt,
        };
      }),
    ];

    // Get current live activities for all teachers and admins in parallel
    const allStaffRaw = allStaff;
    const allStaffIds = allStaffRaw.map(s => s.id);
    const liveActivities = await this.liveStatusService.getCurrentActivities(
      schoolId,
      allStaffIds,
      'STAFF'
    );

    // Merge activities into staff records
    const staffWithActivities = allStaffRaw.map(staff => ({
      ...staff,
      currentActivity: liveActivities[staff.id] || null,
    }));

    // Apply filtering by role and search
    let filteredStaff = staffWithActivities;
    
    // Sort by creation date (newest first)
    filteredStaff.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    if (search) {
      const searchLower = search.toLowerCase();
      filteredStaff = filteredStaff.filter(
        (staff) =>
          staff.firstName.toLowerCase().includes(searchLower) ||
          staff.lastName.toLowerCase().includes(searchLower) ||
          staff.email?.toLowerCase().includes(searchLower) ||
          (staff.subject?.toLowerCase().includes(searchLower) ?? false) ||
          (staff.role?.toLowerCase().includes(searchLower) ?? false)
      );
    }

    if (roleFilter && roleFilter !== 'All') {
      filteredStaff = filteredStaff.filter((staff) => staff.role === roleFilter);
    }

    // KPI counts ignore the status pill so the cards stay stable while the list filters.
    const statusCounts = {
      active: 0,
      pending: 0,
      suspended: 0,
      archived: 0,
    };
    for (const member of filteredStaff) {
      switch (member.accountStatus) {
        case 'ACTIVE':
          statusCounts.active += 1;
          break;
        case 'SHADOW':
          statusCounts.pending += 1;
          break;
        case 'SUSPENDED':
          statusCounts.suspended += 1;
          break;
        case 'ARCHIVED':
          statusCounts.archived += 1;
          break;
      }
    }

    const accountStatusFilter = {
      active: 'ACTIVE',
      pending: 'SHADOW',
      suspended: 'SUSPENDED',
    } as const;
    const selectedStatus = query.status ? accountStatusFilter[query.status] : undefined;
    if (selectedStatus) {
      filteredStaff = filteredStaff.filter((member) => member.accountStatus === selectedStatus);
    }

    // Extract unique roles from all staff (before pagination)
    const availableRolesSet = new Set<string>();
    allAdmins.forEach((admin) => {
      if (admin.role) availableRolesSet.add(admin.role);
    });
    if (filteredTeachers.length > 0) {
      availableRolesSet.add('Teacher');
    }

    // Pagination follows the status pill. statusCounts above does not.
    const totalCount = filteredStaff.length;
    const totalPages = Math.ceil(totalCount / limit);
    const paginatedStaff = filteredStaff.slice(skip, skip + limit);

    const meta: StaffListMetaDto = {
      total: totalCount,
      page,
      limit,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
      statusCounts,
    };

    return {
      items: paginatedStaff,
      meta,
      availableRoles: ['All', ...Array.from(availableRolesSet).sort()],
    };
  }

  /**
   * Upload school logo
   */
  async uploadLogo(user: UserWithContext, file: Express.Multer.File): Promise<SchoolDto> {
    const schoolId = user.currentSchoolId;

    if (!schoolId) {
      throw new BadRequestException('You are not associated with any school');
    }

    const school = await this.schoolRepository.findById(schoolId);

    if (!school) {
      throw new BadRequestException('School not found');
    }

    // Validate file
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    // Validate file type
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedMimeTypes.includes(file.mimetype)) {
      throw new BadRequestException(
        'Invalid file type. Only JPEG, PNG, GIF, and WebP images are allowed'
      );
    }

    // Validate file size (5MB max)
    const maxSize = 5 * 1024 * 1024;
    if (file.size > maxSize) {
      throw new BadRequestException('File size exceeds maximum limit of 5MB');
    }

    // Delete old logo if exists
    if (school.logo) {
      const oldPublicId = this.cloudinaryService.extractPublicId(school.logo);
      if (oldPublicId) {
        try {
          await this.cloudinaryService.deleteImage(oldPublicId);
        } catch (error) {
          console.error('Error deleting old logo:', error);
          // Continue even if deletion fails
        }
      }
    }

    // Upload to Cloudinary
    const { url } = await this.cloudinaryService.uploadImage(
      file,
      `schools/${schoolId}/logo`,
      `school-${schoolId}-logo`
    );

    // Update school with new logo URL
    const updatedSchool = await this.prisma.school.update({
      where: { id: school.id },
      data: { logo: url },
      include: {
        admins: {
          include: { user: true },
          orderBy: { role: 'asc' },
        },
        teachers: true,
        enrollments: {
          where: { isActive: true },
        },
      },
    });

    return this.schoolMapper.toDto(updatedSchool);
  }

  /**
   * Update school information
   * School admins can update basic fields directly, but sensitive changes require token verification
   */
  async updateSchool(
    user: UserWithContext,
    updateSchoolDto: UpdateSchoolDto,
    verificationToken?: string
  ): Promise<SchoolDto> {
    const schoolId = user.currentSchoolId;

    if (!schoolId) {
      throw new BadRequestException('You are not associated with any school');
    }

    const school = await this.schoolRepository.findById(schoolId);

    if (!school) {
      throw new BadRequestException('School not found');
    }

    // Fields that school admins CANNOT change
    const restrictedFields = ['subdomain', 'isActive', 'schoolId'];
    const hasRestrictedFields = restrictedFields.some(
      (field) => updateSchoolDto[field as keyof UpdateSchoolDto] !== undefined
    );

    if (hasRestrictedFields) {
      throw new BadRequestException(
        'You do not have permission to change restricted fields (subdomain, isActive, schoolId)'
      );
    }

    // Check for sensitive changes that require token verification
    const { levels, ...basicFields } = updateSchoolDto;
    const hasSchoolTypeChange =
      levels &&
      ((levels.primary !== undefined && levels.primary !== school.hasPrimary) ||
        (levels.secondary !== undefined && levels.secondary !== school.hasSecondary) ||
        (levels.tertiary !== undefined && levels.tertiary !== school.hasTertiary));

    // If school type is changing, require token verification
    if (hasSchoolTypeChange) {
      if (!verificationToken) {
        throw new BadRequestException(
          'Token verification required for school type changes. Please request a verification token first.'
        );
      }

      // Verify token
      const tokenRecord = await this.prisma.schoolProfileEditToken.findUnique({
        where: { token: verificationToken },
      });

      if (!tokenRecord) {
        await this.logTokenEvent(
          'FAILED',
          verificationToken,
          school.id,
          user.id,
          undefined,
          undefined,
          { reason: 'Token not found during update' }
        );
        throw new UnauthorizedException('Invalid verification token');
      }

      if (tokenRecord.schoolId !== school.id) {
        await this.logTokenEvent(
          'FAILED',
          verificationToken,
          tokenRecord.schoolId,
          user.id,
          undefined,
          undefined,
          { reason: 'Token does not belong to school during update', attemptedSchoolId: school.id }
        );
        throw new UnauthorizedException('Token does not belong to this school');
      }

      if (tokenRecord.usedAt) {
        await this.logTokenEvent(
          'FAILED',
          verificationToken,
          school.id,
          user.id,
          undefined,
          undefined,
          { reason: 'Token already used during update', usedAt: tokenRecord.usedAt }
        );
        throw new UnauthorizedException('Verification token has already been used');
      }

      if (tokenRecord.expiresAt < new Date()) {
        await this.logTokenEvent(
          'FAILED',
          verificationToken,
          school.id,
          user.id,
          undefined,
          undefined,
          { reason: 'Token expired during update', expiresAt: tokenRecord.expiresAt }
        );
        throw new UnauthorizedException('Verification token has expired');
      }

      // Verify the changes match what was requested
      const requestedChanges = tokenRecord.changes as any;
      const requestedLevels = requestedChanges.levels || {};

      // Normalize both objects to ensure consistent comparison
      // Convert undefined to false for comparison purposes
      const normalizeLevels = (lev: any) => ({
        primary: lev?.primary ?? false,
        secondary: lev?.secondary ?? false,
        tertiary: lev?.tertiary ?? false,
      });

      const normalizedRequested = normalizeLevels(requestedLevels);
      const normalizedIncoming = normalizeLevels(levels);

      // Compare normalized values
      if (
        normalizedIncoming.primary !== normalizedRequested.primary ||
        normalizedIncoming.secondary !== normalizedRequested.secondary ||
        normalizedIncoming.tertiary !== normalizedRequested.tertiary
      ) {
        throw new BadRequestException('Changes do not match the verification token');
      }

      // Mark token as used
      await this.prisma.schoolProfileEditToken.update({
        where: { id: tokenRecord.id },
        data: { usedAt: new Date() },
      });

      // Log token usage
      await this.logTokenEvent(
        'USED',
        verificationToken,
        school.id,
        user.id,
        undefined,
        undefined,
        { changesApplied: true }
      );

      this.logger.log(
        `Token used for school ${school.id} by user ${user.id} - changes applied`
      );
    }

    // Prepare update data
    const updateData: any = { ...basicFields };

    // Only update school type if levels are provided and verified
    if (levels && (hasSchoolTypeChange ? verificationToken : true)) {
      if (levels.primary !== undefined) updateData.hasPrimary = levels.primary;
      if (levels.secondary !== undefined) updateData.hasSecondary = levels.secondary;
      if (levels.tertiary !== undefined) updateData.hasTertiary = levels.tertiary;
    }

    // Update school
    const updatedSchool = await this.prisma.school.update({
      where: { id: school.id },
      data: updateData,
      include: {
        admins: {
          include: { user: true },
          orderBy: { role: 'asc' },
        },
        teachers: true,
        enrollments: {
          where: { isActive: true },
        },
      },
    });

    return this.schoolMapper.toDto(updatedSchool);
  }

  /**
   * Log token events for audit trail
   */
  private async logTokenEvent(
    event: 'REQUESTED' | 'VERIFIED' | 'USED' | 'FAILED',
    token: string,
    schoolId: string,
    userId: string | null,
    ipAddress?: string,
    userAgent?: string,
    details?: any
  ): Promise<void> {
    try {
      await this.prisma.schoolProfileEditTokenAudit.create({
        data: {
          token,
          schoolId,
          userId: userId || null,
          event,
          ipAddress: ipAddress || null,
          userAgent: userAgent || null,
          details: details ? (details as any) : null,
        },
      });

      // Log suspicious activity
      if (event === 'FAILED') {
        await this.checkSuspiciousActivity(token, schoolId, ipAddress);
      }
    } catch (error) {
      // Don't fail the main operation if audit logging fails
      this.logger.error(`Failed to log token event: ${event}`, error);
    }
  }

  /**
   * Check for suspicious activity and alert
   */
  private async checkSuspiciousActivity(
    token: string,
    schoolId: string,
    ipAddress?: string
  ): Promise<void> {
    if (!ipAddress) return;

    try {
      // Count recent failures from same IP
      const recentFailures = await this.prisma.schoolProfileEditTokenAudit.count({
        where: {
          event: 'FAILED',
          ipAddress,
          createdAt: {
            gte: new Date(Date.now() - 60 * 60 * 1000), // Last hour
          },
        },
      });

      if (recentFailures >= this.SUSPICIOUS_FAILURE_THRESHOLD) {
        this.logger.warn(
          `Suspicious activity detected: ${recentFailures} failed token attempts from IP ${ipAddress} for school ${schoolId}`
        );
        // In production, you might want to send an alert to security team
        // await this.sendSecurityAlert(ipAddress, schoolId, recentFailures);
      }
    } catch (error) {
      this.logger.error('Failed to check suspicious activity', error);
    }
  }

  /**
   * Cleanup expired tokens (should be called by a scheduled job)
   */
  async cleanupExpiredTokens(): Promise<number> {
    try {
      const result = await this.prisma.schoolProfileEditToken.deleteMany({
        where: {
          OR: [
            { expiresAt: { lt: new Date() } },
            {
              AND: [
                { usedAt: { not: null } },
                { createdAt: { lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } }, // 7 days old
              ],
            },
          ],
        },
      });

      this.logger.log(`Cleaned up ${result.count} expired/used tokens`);
      return result.count;
    } catch (error) {
      this.logger.error('Failed to cleanup expired tokens', error);
      return 0;
    }
  }

  /**
   * Request verification token for sensitive school profile changes
   * Sends an email with verification token
   */
  async requestEditToken(
    user: UserWithContext,
    changes: UpdateSchoolDto,
    ipAddress?: string,
    userAgent?: string
  ): Promise<{ message: string; token?: string }> {
    const schoolId = user.currentSchoolId;

    if (!schoolId) {
      throw new BadRequestException('You are not associated with any school');
    }

    const school = await this.schoolRepository.findById(schoolId);

    if (!school) {
      throw new BadRequestException('School not found');
    }

    // Check if changes include sensitive fields
    const { levels } = changes;
    const hasSchoolTypeChange =
      levels &&
      ((levels.primary !== undefined && levels.primary !== school.hasPrimary) ||
        (levels.secondary !== undefined && levels.secondary !== school.hasSecondary) ||
        (levels.tertiary !== undefined && levels.tertiary !== school.hasTertiary));

    if (!hasSchoolTypeChange) {
      throw new BadRequestException(
        'No sensitive changes detected. You can update these fields directly without verification.'
      );
    }

    // Check token request limits (max 10 per 24 hours per school)
    const recentTokenCount = await this.prisma.schoolProfileEditToken.count({
      where: {
        schoolId: school.id,
        createdAt: {
          gte: new Date(Date.now() - 24 * 60 * 60 * 1000), // Last 24 hours
        },
      },
    });

    if (recentTokenCount >= this.MAX_TOKEN_REQUESTS_PER_24H) {
      await this.logTokenEvent(
        'FAILED',
        'N/A',
        school.id,
        user.id,
        ipAddress,
        userAgent,
        { reason: 'Token request limit exceeded' }
      );
      throw new BadRequestException(
        `Too many token requests. Maximum ${this.MAX_TOKEN_REQUESTS_PER_24H} requests per 24 hours. Please try again later.`
      );
    }

    // Get principal-level admin email for verification (any principal role)
    const allAdmins = await this.prisma.schoolAdmin.findMany({
      where: {
        schoolId: school.id,
      },
      include: { user: true },
    });

    // Find any principal-level admin by tier, not by title
    const principal = allAdmins.find(admin => hasPrincipalAccess(admin));

    if (!principal || !principal.user?.email) {
      throw new BadRequestException(
        'Principal-level admin email not found. Please ensure your school has a principal or school owner with an email address.'
      );
    }

    // Generate token
    const token = `SPET-${randomBytes(32).toString('hex').toUpperCase()}`;
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24); // Token expires in 24 hours

    // Store token with proposed changes
    await this.prisma.schoolProfileEditToken.create({
      data: {
        token,
        schoolId: school.id,
        changes: changes as any,
        expiresAt,
      },
    });

    const frontendUrl = (await this.portals.getSchoolFrontendUrl(school.id)).replace(/\/+$/, '');
    const verificationUrl = `${frontendUrl}/dashboard/school/settings/profile?token=${token}`;

    await this.emailService.sendSchoolProfileEditVerificationEmail(
      principal.user.email,
      `${principal.firstName} ${principal.lastName}`,
      school.name,
      token,
      verificationUrl,
      changes
    );

    // Log token request
    await this.logTokenEvent(
      'REQUESTED',
      token,
      school.id,
      user.id,
      ipAddress,
      userAgent,
      { principalEmail: principal.user.email }
    );

    this.logger.log(
      `Token requested for school ${school.id} by user ${user.id} from IP ${ipAddress || 'unknown'}`
    );

    return {
      message: `Verification email sent to ${principal.user.email}. Please check your email to complete the profile update.`,
    };
  }

  /**
   * Verify edit token and get proposed changes
   */
  async verifyEditToken(
    token: string,
    user: UserWithContext,
    ipAddress?: string,
    userAgent?: string
  ): Promise<{ changes: UpdateSchoolDto; school: SchoolDto }> {
    const schoolId = user.currentSchoolId;

    if (!schoolId) {
      throw new BadRequestException('You are not associated with any school');
    }

    const tokenRecord = await this.prisma.schoolProfileEditToken.findUnique({
      where: { token },
      include: {
        school: {
          include: {
            admins: {
              include: { user: true },
              orderBy: { role: 'asc' },
            },
            teachers: true,
            enrollments: {
              where: { isActive: true },
            },
          },
        },
      },
    });

    if (!tokenRecord) {
      await this.logTokenEvent(
        'FAILED',
        token,
        schoolId,
        user.id,
        ipAddress,
        userAgent,
        { reason: 'Token not found' }
      );
      throw new NotFoundException('Invalid verification token');
    }

    if (tokenRecord.schoolId !== schoolId) {
      await this.logTokenEvent(
        'FAILED',
        token,
        tokenRecord.schoolId,
        user.id,
        ipAddress,
        userAgent,
        { reason: 'Token does not belong to user school', attemptedSchoolId: schoolId }
      );
      throw new UnauthorizedException('Token does not belong to your school');
    }

    if (tokenRecord.usedAt) {
      await this.logTokenEvent(
        'FAILED',
        token,
        schoolId,
        user.id,
        ipAddress,
        userAgent,
        { reason: 'Token already used', usedAt: tokenRecord.usedAt }
      );
      throw new BadRequestException('This verification token has already been used');
    }

    if (tokenRecord.expiresAt < new Date()) {
      await this.logTokenEvent(
        'FAILED',
        token,
        schoolId,
        user.id,
        ipAddress,
        userAgent,
        { reason: 'Token expired', expiresAt: tokenRecord.expiresAt }
      );
      throw new BadRequestException('Verification token has expired. Please request a new token.');
    }

    // Log successful verification
    await this.logTokenEvent(
      'VERIFIED',
      token,
      schoolId,
      user.id,
      ipAddress,
      userAgent
    );

    this.logger.log(
      `Token verified for school ${schoolId} by user ${user.id} from IP ${ipAddress || 'unknown'}`
    );

    return {
      changes: tokenRecord.changes as UpdateSchoolDto,
      school: this.schoolMapper.toDto(tokenRecord.school),
    };
  }
}
