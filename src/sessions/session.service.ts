import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { EmailService } from '../email/email.service';
import { SchoolRepository } from '../schools/domain/repositories/school.repository';
import {
  InitializeSessionDto,
  CreateTermDto,
  MigrateStudentsDto,
  UpdateTermDatesDto,
  UpdateSessionDatesDto,
  RecalibrateTermsMode,
  SessionType,
  TermDateDto,
} from './dto/initialize-session.dto';
import { SchoolValidatorService } from '../schools/shared/school-validator.service';
import { AcademicSessionDto, TermDto, ActiveSessionDto } from './dto/session.dto';
import { SessionStatus, TermStatus } from '@prisma/client';
import { Cron, CronExpression } from '@nestjs/schedule';
import { NotificationService } from '../notification/notification.service';
import { NotificationInboxService } from '../notification/notification-inbox.service';
import {
  buildHalfTermRange,
  getTeachingWeekInfo,
  DEFAULT_WORKING_DAYS,
  type WorkingDay,
} from '../common/utils/instructional-day.util';
import {
  getTermPhase,
  isExamScheduleActive,
  isLessonScheduleActive,
} from '../common/utils/term-phase.util';
import { buildNigerianHolidayEvents } from '../common/utils/nigerian-holidays.util';
import { EventType } from '@prisma/client';
import { SchoolSettingsService } from '../school-settings/school-settings.service';

const DEFAULT_WORKING_DAYS_FOR_TERM = DEFAULT_WORKING_DAYS as WorkingDay[];
const SESSION_START_GRACE_DAYS = 7;
/**
 * Service for managing academic sessions and terms
 * Handles the "Start Term" wizard and student migration logic
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly schoolRepository: SchoolRepository,
    private readonly emailService: EmailService,
    private readonly schoolValidator: SchoolValidatorService,
    private readonly notificationService: NotificationService,
    private readonly notificationInbox: NotificationInboxService,
    private readonly schoolSettingsService: SchoolSettingsService,
  ) { }

  /**
   * Find the active session for a school type, including legacy sessions with null schoolType.
   */
  private async findActiveSessionForSchoolType(
    schoolId: string,
    schoolType?: string | null,
  ) {
    const normalizedType = schoolType ?? null;

    const session = await this.prisma.academicSession.findFirst({
      where: {
        schoolId,
        status: SessionStatus.ACTIVE,
        schoolType: normalizedType,
      },
    });

    if (session) {
      return session;
    }

    if (!normalizedType) {
      return null;
    }

    // Legacy: sessions created before per-type scoping used null schoolType
    return this.prisma.academicSession.findFirst({
      where: {
        schoolId,
        status: SessionStatus.ACTIVE,
        schoolType: null,
      },
    });
  }

  /**
   * Mark a session COMPLETED when no terms remain ACTIVE (e.g. admin ended the last term).
   */
  private async completeSessionIfNoActiveTerms(sessionId: string): Promise<boolean> {
    const activeTermCount = await this.prisma.term.count({
      where: {
        academicSessionId: sessionId,
        status: TermStatus.ACTIVE,
      },
    });

    if (activeTermCount > 0) {
      return false;
    }

    await this.prisma.academicSession.update({
      where: { id: sessionId },
      data: { status: SessionStatus.COMPLETED },
    });

    return true;
  }

  /**
   * Create a term for an academic session
   */
  async createTerm(schoolId: string, sessionId: string, dto: CreateTermDto): Promise<TermDto> {
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }
    await this.schoolValidator.validateSchoolActive(school.id);

    const session = await this.prisma.academicSession.findFirst({
      where: {
        id: sessionId,
        schoolId: school.id,
      },
    });

    if (!session) {
      throw new NotFoundException('Academic session not found');
    }

    const termNumber = parseInt(dto.number);
    if (termNumber < 1 || termNumber > 3) {
      throw new BadRequestException('Term number must be between 1 and 3');
    }

    // Check if term number already exists
    const existingTerm = await this.prisma.term.findFirst({
      where: {
        academicSessionId: sessionId,
        number: termNumber,
      },
    });

    if (existingTerm) {
      throw new ConflictException(`Term ${termNumber} already exists for this session`);
    }

    const startDate = new Date(dto.startDate);
    const endDate = new Date(dto.endDate);

    // Validate dates are within session dates
    if (startDate < session.startDate || endDate > session.endDate) {
      throw new BadRequestException('Term dates must be within session dates');
    }

    const term = await this.prisma.term.create({
      data: {
        name: dto.name,
        number: termNumber,
        startDate: startDate,
        endDate: endDate,
        halfTermStart: dto.halfTermStart ? new Date(dto.halfTermStart) : null,
        halfTermEnd: dto.halfTermEnd ? new Date(dto.halfTermEnd) : null,
        midtermStart: dto.midtermStart ? new Date(dto.midtermStart) : null,
        midtermEnd: dto.midtermEnd ? new Date(dto.midtermEnd) : null,
        examStart: dto.examStart ? new Date(dto.examStart) : null,
        examEnd: dto.examEnd ? new Date(dto.examEnd) : null,
        status: TermStatus.DRAFT,
        academicSessionId: sessionId,
      } as any,
    });

    return this.toTermDto(term, session.schoolId);
  }

  /**
   * Get active session and term for a school (optionally filtered by school type)
   */
  async getActiveSession(schoolId: string, schoolType?: string): Promise<ActiveSessionDto> {
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    const session = await this.findActiveSessionForSchoolType(school.id, schoolType);

    const sessionWithTerms = session
      ? await this.prisma.academicSession.findUnique({
          where: { id: session.id },
          include: {
            terms: {
              where: {
                status: TermStatus.ACTIVE,
              },
              orderBy: {
                number: 'desc',
              },
              take: 1,
            },
          },
        })
      : null;

    if (!sessionWithTerms) {
      return { session: undefined, term: undefined };
    }

    return {
      session: await this.toSessionDto(sessionWithTerms),
      term:
        sessionWithTerms.terms.length > 0
          ? await this.toTermDto(sessionWithTerms.terms[0], sessionWithTerms.schoolId)
          : undefined,
    };
  }

  /**
   * Start a new term (the core "Start Term" wizard logic)
   * Supports school-type-specific sessions (PRIMARY, SECONDARY, TERTIARY)
   */
  async startNewTerm(
    schoolId: string,
    dto: InitializeSessionDto & { termId?: string }
  ): Promise<{
    session: AcademicSessionDto;
    term: TermDto;
    migratedCount: number;
  }> {
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }
    await this.schoolValidator.validateSchoolActive(school.id);

    let session: any;
    let term: any;
    const schoolType = dto.schoolType || null;
    const isTertiary = schoolType === 'TERTIARY';

    if (dto.type === SessionType.NEW_SESSION) {
      const activeSession = await this.findActiveSessionForSchoolType(
        school.id,
        schoolType,
      );

      if (activeSession) {
        const completedStaleSession = await this.completeSessionIfNoActiveTerms(
          activeSession.id,
        );

        if (!completedStaleSession) {
          throw new ConflictException(
            `Cannot start a new session while ${activeSession.name} is active for ${schoolType || 'this school'}. Please end the current session first.`
          );
        }
      }

      // Validate session duration (must be at least 10 months)
      const startDate = new Date(dto.startDate);
      const endDate = new Date(dto.endDate);
      const monthsDiff =
        (endDate.getFullYear() - startDate.getFullYear()) * 12 +
        (endDate.getMonth() - startDate.getMonth());
      const daysDiff = Math.floor(
        (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)
      );

      if (monthsDiff < 10 || daysDiff < 300) {
        throw new BadRequestException(
          'An academic session must span at least 10 months (approximately one year). Please select appropriate start and end dates.'
        );
      }

      if (monthsDiff > 12 || daysDiff > 370) {
        throw new BadRequestException(
          'An academic session cannot exceed 12 months.'
        );
      }

      // Session names are unique per school type — use a new year label for each session
      const existingSession = await this.prisma.academicSession.findFirst({
        where: {
          schoolId: school.id,
          name: dto.name,
          schoolType: schoolType,
        },
      });

      if (existingSession) {
        throw new ConflictException(
          `A session named "${dto.name}" already exists for ${schoolType || 'this school'}. Each academic year needs a unique session name (e.g. 2026/2027). Use session date editing to fix mistakes in the current session.`
        );
      }

      // Create new session with school type
      session = await this.prisma.academicSession.create({
        data: {
          name: dto.name,
          startDate: startDate,
          endDate: endDate,
          status: SessionStatus.ACTIVE,
          schoolId: school.id,
          schoolType: schoolType,
        },
      });

      // Deactivate previous session for the same school type
      await this.prisma.academicSession.updateMany({
        where: {
          schoolId: school.id,
          status: SessionStatus.ACTIVE,
          schoolType: schoolType,
          id: { not: session.id },
        },
        data: {
          status: SessionStatus.COMPLETED,
        },
      });

      // Determine which term to activate (defaults to 1 for backward compat)
      const startingTermNumber = dto.startingTermNumber || 1;

      // Create terms/semesters based on school type
      // TERTIARY: 2 semesters, PRIMARY/SECONDARY: 3 terms
      const termCount = isTertiary ? 2 : 3;
      const termLabel = isTertiary ? 'Semester' : 'Term';

      // Validate startingTermNumber range
      if (startingTermNumber > termCount) {
        throw new BadRequestException(
          `Starting ${termLabel.toLowerCase()} number cannot exceed ${termCount} for ${isTertiary ? 'tertiary' : 'primary/secondary'} schools.`
        );
      }

      // Build the date ranges for each term – either from custom termDates or auto-calculated
      const termRanges = this.buildTermDateRanges(
        startDate,
        endDate,
        termCount,
        dto.termDates,
      );

      // Create all terms, activate the starting term
      for (const range of termRanges) {
        const isStartingTerm = range.number === startingTermNumber;
        const ordinal = range.number === 1 ? '1st' : range.number === 2 ? '2nd' : '3rd';

        const createdTerm = await this.prisma.term.create({
          data: {
            name: `${ordinal} ${termLabel}`,
            number: range.number,
            startDate: range.startDate,
            endDate: range.endDate,
            status: isStartingTerm ? TermStatus.ACTIVE : (
              range.number < startingTermNumber ? TermStatus.COMPLETED : TermStatus.DRAFT
            ),
            academicSessionId: session.id,
          },
        });

        if (isStartingTerm) {
          term = createdTerm;
        }
      }

      // Seed Nigerian public holidays onto the school calendar for this session window
      await this.seedNigerianHolidaysForSession(school.id, startDate, endDate, schoolType);

      // Deactivate previous terms for the same school type
      await this.prisma.term.updateMany({
        where: {
          academicSession: {
            schoolId: school.id,
            schoolType: schoolType,
          },
          status: TermStatus.ACTIVE,
          id: { not: term.id },
        },
        data: {
          status: TermStatus.COMPLETED,
        },
      });

      // Student migration for new session: promote or carry over based on admin choice
      let migratedCount = 0;
      let promotedStudents: Array<{
        email: string;
        name: string;
        previousClass: string;
        newClass: string;
      }> = [];

      if (dto.carryOver) {
        const previousTerm = await this.prisma.term.findFirst({
          where: {
            academicSession: {
              schoolId: school.id,
              schoolType: schoolType,
            },
            id: { not: term.id },
            status: { in: [TermStatus.ACTIVE, TermStatus.COMPLETED] },
          },
          orderBy: [{ academicSession: { startDate: 'desc' } }, { number: 'desc' }],
        });

        migratedCount = await this.carryOverStudents(
          school.id,
          term.id,
          previousTerm?.id,
          schoolType,
        );
      } else {
        const promotionResult = await this.promoteStudentsWithTracking(
          school.id,
          term.id,
          schoolType,
        );
        migratedCount = promotionResult.promotedCount;
        promotedStudents = promotionResult.promotedStudents;
      }

      // Send session start notifications to all school members (in background)
      this.sendSessionTermNotifications(
        school.id,
        school.name,
        session.name,
        term.name,
        new Date(dto.startDate),
        new Date(dto.endDate),
        true, // isNewSession
        schoolType
      );

      // Send promotion emails to promoted students (in background)
      if (promotedStudents.length > 0) {
        this.sendPromotionEmails(promotedStudents, session.name, school.name);
      }

      return {
        session: await this.toSessionDto(session),
        term: await this.toTermDto(term, school.id),
        migratedCount,
      };
    } else {
      // NEW_TERM - Create new term in existing session
      if (!dto.termId) {
        throw new BadRequestException('termId is required for NEW_TERM type');
      }

      const existingTerm = await this.prisma.term.findUnique({
        where: { id: dto.termId },
        include: { academicSession: true },
      });

      if (!existingTerm || existingTerm.academicSession.schoolId !== school.id) {
        throw new NotFoundException('Term not found');
      }

      // Find previous active term
      const previousTerm = await this.prisma.term.findFirst({
        where: {
          academicSessionId: existingTerm.academicSessionId,
          status: TermStatus.ACTIVE,
          id: { not: dto.termId },
        },
        orderBy: {
          number: 'desc',
        },
      });

      // Activate the new term
      term = await this.prisma.term.update({
        where: { id: dto.termId },
        data: {
          status: TermStatus.ACTIVE,
        },
      });

      // Deactivate previous term
      if (previousTerm) {
        await this.prisma.term.update({
          where: { id: previousTerm.id },
          data: {
            status: TermStatus.COMPLETED,
          },
        });
      }

      session = await this.prisma.academicSession.findUnique({
        where: { id: existingTerm.academicSessionId },
      });

      // Clone timetables from previous term
      if (previousTerm) {
        await this.cloneTimetables(previousTerm.id, term.id);
      }

      // Get schoolType from the session for carry over
      const sessionSchoolType = session?.schoolType || null;

      // Trigger carry over logic (filtered by school type)
      const migratedCount = await this.carryOverStudents(
        school.id,
        term.id,
        previousTerm?.id,
        sessionSchoolType
      );

      // Send term start notifications to all school members (in background)
      this.sendSessionTermNotifications(
        school.id,
        school.name,
        session?.name || '',
        term.name,
        term.startDate,
        term.endDate,
        false, // isNewSession = false (this is a new term)
        sessionSchoolType
      );

      return {
        session: await this.toSessionDto(session),
        term: await this.toTermDto(term, school.id),
        migratedCount,
      };
    }
  }

  /**
   * Clone timetables from one term to another
   */
  private async cloneTimetables(fromTermId: string, toTermId: string): Promise<number> {
    const existingPeriods = await this.prisma.timetablePeriod.findMany({
      where: { termId: fromTermId },
    });

    let clonedCount = 0;

    for (const period of existingPeriods) {
      // Check if a period already exists at this slot in the new term
      const existsInNewTerm = await this.prisma.timetablePeriod.findFirst({
        where: {
          termId: toTermId,
          classId: period.classId,
          classArmId: period.classArmId,
          dayOfWeek: period.dayOfWeek,
          startTime: period.startTime,
        },
      });

      if (!existsInNewTerm) {
        await this.prisma.timetablePeriod.create({
          data: {
            dayOfWeek: period.dayOfWeek,
            startTime: period.startTime,
            endTime: period.endTime,
            type: period.type,
            subjectId: period.subjectId,
            courseId: period.courseId,
            teacherId: period.teacherId,
            roomId: period.roomId,
            classId: period.classId,
            classArmId: period.classArmId,
            termId: toTermId,
          },
        });
        clonedCount++;
      }
    }

    return clonedCount;
  }

  /**
   * Migrate students (promote or carry over)
   */
  async migrateStudents(
    schoolId: string,
    dto: MigrateStudentsDto
  ): Promise<{ migratedCount: number }> {
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    const term = await this.prisma.term.findUnique({
      where: { id: dto.termId },
      include: { academicSession: true },
    });

    if (!term || term.academicSession.schoolId !== school.id) {
      throw new NotFoundException('Term not found');
    }

    if (dto.carryOver) {
      // Find previous term
      const previousTerm = await this.prisma.term.findFirst({
        where: {
          academicSessionId: term.academicSessionId,
          number: { lt: term.number },
        },
        orderBy: {
          number: 'desc',
        },
      });

      if (!previousTerm) {
        throw new BadRequestException('No previous term found for carry over');
      }

      const migratedCount = await this.carryOverStudents(school.id, term.id, previousTerm.id);
      return { migratedCount };
    } else {
      const migratedCount = await this.promoteStudents(school.id, term.id);
      return { migratedCount };
    }
  }

  /**
   * Ensure ClassLevels have nextLevelId set up for promotion
   * This fixes existing ClassLevels that were created without the progression chain
   */
  private async ensureClassLevelProgression(
    schoolId: string,
    schoolType?: string | null
  ): Promise<void> {
    // Get all class levels for this school type, ordered by level
    const classLevels = await this.prisma.classLevel.findMany({
      where: {
        schoolId,
        type: schoolType || undefined,
      },
      orderBy: {
        level: 'asc',
      },
    });

    // Check if any levels need nextLevelId set
    const needsUpdate = classLevels.some(
      (level, index) => index < classLevels.length - 1 && !level.nextLevelId
    );

    if (needsUpdate) {
      console.log(`Setting up nextLevelId chain for ${classLevels.length} class levels...`);
      // Set up the chain
      for (let i = 0; i < classLevels.length - 1; i++) {
        if (!classLevels[i].nextLevelId) {
          await this.prisma.classLevel.update({
            where: { id: classLevels[i].id },
            data: { nextLevelId: classLevels[i + 1].id },
          });
        }
      }
    }
  }

  /**
   * Promotion Logic: Move students from currentLevel to nextLevel
   * JSS1 -> JSS2, SS3 -> ALUMNI
   * Handles both:
   * - Enrollments with classArm linked (proper setup)
   * - Enrollments with only classLevel string (legacy/simple setup)
   */
  private async promoteStudents(
    schoolId: string,
    termId: string,
    schoolType?: string | null
  ): Promise<number> {
    // Ensure ClassLevel progression is set up
    await this.ensureClassLevelProgression(schoolId, schoolType);

    // Get the previous active term for this school type (could be from previous session)
    const previousTerm = await this.prisma.term.findFirst({
      where: {
        academicSession: {
          schoolId: schoolId,
          schoolType: schoolType || null,
        },
        id: { not: termId },
        status: { in: [TermStatus.ACTIVE, TermStatus.COMPLETED] },
      },
      orderBy: [{ academicSession: { startDate: 'desc' } }, { number: 'desc' }],
    });

    // Get all active enrollments - either from previous term OR enrollments without termId
    // Don't filter by class.type since classId might be null
    const previousEnrollments = await this.prisma.enrollment.findMany({
      where: {
        schoolId: schoolId,
        isActive: true,
        // Either has the previous term's ID, or has no termId (legacy enrollment)
        OR: [...(previousTerm ? [{ termId: previousTerm.id }] : []), { termId: null }],
      },
      include: {
        classArm: {
          include: {
            classLevel: true,
          },
        },
        class: true,
      },
    });

    // If schoolType is specified, filter enrollments by class type (if class exists) or by classLevel name pattern
    const filteredEnrollments = schoolType
      ? previousEnrollments.filter((e) => {
        // If class is linked, check its type
        if (e.class?.type) {
          return e.class.type === schoolType;
        }
        // Otherwise, try to infer from classLevel string
        // PRIMARY: Class 1-6, Primary 1-6
        // SECONDARY: JSS1-3, SS1-3
        // TERTIARY: 100L-500L
        const level = e.classLevel?.toUpperCase() || '';
        if (schoolType === 'PRIMARY') {
          return level.includes('CLASS') || level.includes('PRIMARY') || /^P[1-6]$/i.test(level);
        }
        if (schoolType === 'SECONDARY') {
          return level.includes('JSS') || level.includes('SS') || level.includes('SECONDARY');
        }
        if (schoolType === 'TERTIARY') {
          return /\d+L/.test(level) || level.includes('LEVEL');
        }
        return true; // Include if can't determine
      })
      : previousEnrollments;

    let promotedCount = 0;

    for (const enrollment of filteredEnrollments) {
      // Try to get current level from classArm first, then fall back to looking up by name
      let currentLevel: any = null;

      if (enrollment.classArm?.classLevel) {
        currentLevel = enrollment.classArm.classLevel;
      } else if (enrollment.classLevel) {
        // Look up ClassLevel by name for this school
        currentLevel = await this.prisma.classLevel.findFirst({
          where: {
            schoolId: schoolId,
            OR: [{ name: enrollment.classLevel }, { code: enrollment.classLevel }],
          },
        });
      }

      if (!currentLevel) {
        // Can't determine current level, skip but log
        console.warn(
          `Cannot determine class level for enrollment ${enrollment.id}, classLevel: ${enrollment.classLevel}`
        );
        continue;
      }

      // Find next level
      const nextLevel = currentLevel.nextLevelId
        ? await this.prisma.classLevel.findUnique({
          where: { id: currentLevel.nextLevelId },
        })
        : null;

      if (!nextLevel) {
        // Highest level (SS3/500L) -> ALUMNI
        // Mark enrollment as completed
        await this.prisma.enrollment.update({
          where: { id: enrollment.id },
          data: { isActive: false },
        });
        promotedCount++;
        continue;
      }

      // Try to find a class arm for the next level
      const nextClassArm = await this.prisma.classArm.findFirst({
        where: {
          classLevelId: nextLevel.id,
          isActive: true,
        },
      });

      // Create new enrollment in next level
      await this.prisma.enrollment.create({
        data: {
          studentId: enrollment.studentId,
          schoolId: schoolId,
          classArmId: nextClassArm?.id || null, // May be null if no class arms set up
          termId: termId,
          classLevel: nextLevel.name,
          academicYear: enrollment.academicYear,
          isActive: true,
          debtBalance: 0,
        },
      });

      // Deactivate old enrollment
      await this.prisma.enrollment.update({
        where: { id: enrollment.id },
        data: { isActive: false },
      });

      promotedCount++;
    }

    return promotedCount;
  }

  /**
   * Promotion Logic with tracking - same as promoteStudents but also returns
   * details of promoted students for email notifications
   */
  private async promoteStudentsWithTracking(
    schoolId: string,
    termId: string,
    schoolType?: string | null
  ): Promise<{
    promotedCount: number;
    promotedStudents: Array<{
      email: string;
      name: string;
      previousClass: string;
      newClass: string;
    }>;
  }> {
    // Ensure ClassLevel progression is set up
    await this.ensureClassLevelProgression(schoolId, schoolType);

    // Get the previous active term for this school type
    const previousTerm = await this.prisma.term.findFirst({
      where: {
        academicSession: {
          schoolId: schoolId,
          schoolType: schoolType || null,
        },
        id: { not: termId },
        status: { in: [TermStatus.ACTIVE, TermStatus.COMPLETED] },
      },
      orderBy: [{ academicSession: { startDate: 'desc' } }, { number: 'desc' }],
    });

    // Get all active enrollments with student details
    const previousEnrollments = await this.prisma.enrollment.findMany({
      where: {
        schoolId: schoolId,
        isActive: true,
        OR: [...(previousTerm ? [{ termId: previousTerm.id }] : []), { termId: null }],
      },
      include: {
        classArm: {
          include: {
            classLevel: true,
          },
        },
        class: true,
        student: {
          include: {
            user: true,
          },
        },
      },
    });

    // Filter by school type
    const filteredEnrollments = schoolType
      ? previousEnrollments.filter((e) => {
        if (e.class?.type) {
          return e.class.type === schoolType;
        }
        const level = e.classLevel?.toUpperCase() || '';
        if (schoolType === 'PRIMARY') {
          return level.includes('CLASS') || level.includes('PRIMARY') || /^P[1-6]$/i.test(level);
        }
        if (schoolType === 'SECONDARY') {
          return level.includes('JSS') || level.includes('SS') || level.includes('SECONDARY');
        }
        if (schoolType === 'TERTIARY') {
          return /\d+L/.test(level) || level.includes('LEVEL');
        }
        return true;
      })
      : previousEnrollments;

    let promotedCount = 0;
    const promotedStudents: Array<{
      email: string;
      name: string;
      previousClass: string;
      newClass: string;
    }> = [];

    for (const enrollment of filteredEnrollments) {
      let currentLevel: any = null;

      if (enrollment.classArm?.classLevel) {
        currentLevel = enrollment.classArm.classLevel;
      } else if (enrollment.classLevel) {
        currentLevel = await this.prisma.classLevel.findFirst({
          where: {
            schoolId: schoolId,
            OR: [{ name: enrollment.classLevel }, { code: enrollment.classLevel }],
          },
        });
      }

      if (!currentLevel) {
        console.warn(
          `Cannot determine class level for enrollment ${enrollment.id}, classLevel: ${enrollment.classLevel}`
        );
        continue;
      }

      const previousClassName = currentLevel.name || enrollment.classLevel || 'Unknown';

      // Find next level
      const nextLevel = currentLevel.nextLevelId
        ? await this.prisma.classLevel.findUnique({
          where: { id: currentLevel.nextLevelId },
        })
        : null;

      if (!nextLevel) {
        // Highest level -> ALUMNI
        await this.prisma.enrollment.update({
          where: { id: enrollment.id },
          data: { isActive: false },
        });
        promotedCount++;

        // Track for email (graduating)
        if (enrollment.student?.user?.email) {
          promotedStudents.push({
            email: enrollment.student.user.email,
            name: `${enrollment.student.firstName} ${enrollment.student.lastName}`,
            previousClass: previousClassName,
            newClass: 'Graduated/Alumni',
          });
        }
        continue;
      }

      // Find class arm for next level (for PRIMARY/SECONDARY schools using ClassArms)
      // Get current academic year
      const now = new Date();
      const year = now.getFullYear();
      const academicYear = now.getMonth() >= 8 ? `${year}/${year + 1}` : `${year - 1}/${year}`;

      let nextClassArmId: string | null = null;
      let nextClassId: string | null = null;

      // Check if next level has ClassArms
      const nextLevelArms = await this.prisma.classArm.findMany({
        where: {
          classLevelId: nextLevel.id,
          academicYear: academicYear,
          isActive: true,
        },
        orderBy: { name: 'asc' },
      });

      if (nextLevelArms.length > 0) {
        // School uses ClassArms - distribute students evenly across arms
        // Simple round-robin distribution
        const armIndex = promotedCount % nextLevelArms.length;
        nextClassArmId = nextLevelArms[armIndex].id;
      } else {
        // No ClassArms - try to find a Class for this level
        const nextClass = await this.prisma.class.findFirst({
          where: {
            schoolId: schoolId,
            OR: [{ name: nextLevel.name }, { classLevel: nextLevel.name }],
            isActive: true,
          },
        });
        if (nextClass) {
          nextClassId = nextClass.id;
        }
      }

      // Create new enrollment
      await this.prisma.enrollment.create({
        data: {
          studentId: enrollment.studentId,
          schoolId: schoolId,
          classArmId: nextClassArmId,
          classId: nextClassId,
          termId: termId,
          classLevel: nextLevel.name,
          academicYear: enrollment.academicYear,
          isActive: true,
          debtBalance: 0,
        },
      });

      // Deactivate old enrollment
      await this.prisma.enrollment.update({
        where: { id: enrollment.id },
        data: { isActive: false },
      });

      promotedCount++;

      // Track for email
      if (enrollment.student?.user?.email) {
        promotedStudents.push({
          email: enrollment.student.user.email,
          name: `${enrollment.student.firstName} ${enrollment.student.lastName}`,
          previousClass: previousClassName,
          newClass: nextLevel.name,
        });
      }
    }

    return { promotedCount, promotedStudents };
  }

  /**
   * Carry Over Logic: Clone all active Enrollments from previous term
   * Keep students in the exact same ClassArm/Class
   * Handles enrollments with or without classId linked
   */
  private async carryOverStudents(
    schoolId: string,
    termId: string,
    previousTermId?: string,
    schoolType?: string | null
  ): Promise<number> {
    // Get previous enrollments - either from previous term OR enrollments without termId
    const previousEnrollments = await this.prisma.enrollment.findMany({
      where: {
        schoolId: schoolId,
        isActive: true,
        OR: [...(previousTermId ? [{ termId: previousTermId }] : []), { termId: null }],
      },
      include: {
        class: true,
      },
    });

    // Filter by school type if specified (using class.type or classLevel pattern)
    const filteredEnrollments = schoolType
      ? previousEnrollments.filter((e) => {
        if (e.class?.type) {
          return e.class.type === schoolType;
        }
        // Infer from classLevel string
        const level = e.classLevel?.toUpperCase() || '';
        if (schoolType === 'PRIMARY') {
          return level.includes('CLASS') || level.includes('PRIMARY') || /^P[1-6]$/i.test(level);
        }
        if (schoolType === 'SECONDARY') {
          return level.includes('JSS') || level.includes('SS') || level.includes('SECONDARY');
        }
        if (schoolType === 'TERTIARY') {
          return /\d+L/.test(level) || level.includes('LEVEL');
        }
        return true;
      })
      : previousEnrollments;

    let carriedOverCount = 0;

    for (const enrollment of filteredEnrollments) {
      // Check if enrollment already exists for this term
      const existing = await this.prisma.enrollment.findFirst({
        where: {
          studentId: enrollment.studentId,
          schoolId: schoolId,
          termId: termId,
        },
      });

      if (existing) {
        continue; // Already migrated
      }

      // Clone enrollment to new term
      await this.prisma.enrollment.create({
        data: {
          studentId: enrollment.studentId,
          schoolId: schoolId,
          classId: enrollment.classId,
          classArmId: enrollment.classArmId, // Keep same class arm
          termId: termId,
          classLevel: enrollment.classLevel,
          academicYear: enrollment.academicYear,
          isActive: true,
          debtBalance: enrollment.debtBalance, // Carry over debt
        },
      });

      carriedOverCount++;
    }

    return carriedOverCount;
  }

  /**
   * End the current active term (optionally filtered by school type)
   */
  async endTerm(schoolId: string, schoolType?: string): Promise<{ term: TermDto }> {
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    // Find active term for the specified school type
    const activeTerm = await this.prisma.term.findFirst({
      where: {
        academicSession: {
          schoolId: school.id,
          schoolType: schoolType || null,
        },
        status: TermStatus.ACTIVE,
      },
      include: {
        academicSession: true,
      },
    });

    if (!activeTerm) {
      throw new NotFoundException(`No active term found${schoolType ? ` for ${schoolType}` : ''}`);
    }

    // Update term status to COMPLETED
    const updatedTerm = await this.prisma.term.update({
      where: { id: activeTerm.id },
      data: { status: TermStatus.COMPLETED },
    });

    // When the last active term ends, close the session so a new one can start
    await this.completeSessionIfNoActiveTerms(activeTerm.academicSessionId);

    return {
      term: await this.toTermDto(updatedTerm, activeTerm.academicSessionId ? activeTerm.academicSession?.schoolId : undefined),
    };
  }

  /**
   * End the current active session (optionally filtered by school type)
   * This marks the session and all its terms as COMPLETED
   */
  async endSession(
    schoolId: string,
    schoolType?: string
  ): Promise<{ session: AcademicSessionDto }> {
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    const activeSession = await this.findActiveSessionForSchoolType(
      school.id,
      schoolType,
    );

    if (!activeSession) {
      throw new NotFoundException(
        `No active session found${schoolType ? ` for ${schoolType}` : ''}`
      );
    }

    const sessionWithTerms = await this.prisma.academicSession.findUnique({
      where: { id: activeSession.id },
      include: { terms: true },
    });

    if (!sessionWithTerms) {
      throw new NotFoundException(
        `No active session found${schoolType ? ` for ${schoolType}` : ''}`
      );
    }

    // Mark all terms in this session as COMPLETED
    await this.prisma.term.updateMany({
      where: {
        academicSessionId: sessionWithTerms.id,
      },
      data: {
        status: TermStatus.COMPLETED,
      },
    });

    // Mark session as COMPLETED
    const updatedSession = await this.prisma.academicSession.update({
      where: { id: sessionWithTerms.id },
      data: { status: SessionStatus.COMPLETED },
      include: {
        terms: {
          orderBy: { number: 'asc' },
        },
      },
    });

    return {
      session: await this.toSessionDto(updatedSession),
    };
  }

  /**
   * Reactivate a completed term (continue a term that was ended early)
   * Only allows reactivation if the term's end date hasn't passed yet
   */
  async reactivateTerm(
    schoolId: string,
    termId: string,
    schoolType?: string
  ): Promise<{ term: TermDto }> {
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    // Find the term
    const term = await this.prisma.term.findUnique({
      where: { id: termId },
      include: {
        academicSession: true,
      },
    });

    if (!term) {
      throw new NotFoundException('Term not found');
    }

    // Verify term belongs to this school
    if (term.academicSession.schoolId !== school.id) {
      throw new BadRequestException('Term does not belong to this school');
    }

    // Verify school type matches if specified
    if (schoolType && term.academicSession.schoolType !== schoolType) {
      throw new BadRequestException('Term does not match the specified school type');
    }

    // Check if term is COMPLETED (only completed terms can be reactivated)
    if (term.status !== TermStatus.COMPLETED) {
      throw new BadRequestException('Only completed terms can be reactivated');
    }

    // Check if term's end date hasn't passed yet
    const now = new Date();
    if (term.endDate < now) {
      throw new BadRequestException(
        `Cannot reactivate this term - its end date (${term.endDate.toLocaleDateString()}) has already passed`
      );
    }

    // Deactivate any currently active term for this session
    await this.prisma.term.updateMany({
      where: {
        academicSessionId: term.academicSessionId,
        status: TermStatus.ACTIVE,
      },
      data: {
        status: TermStatus.COMPLETED,
      },
    });

    // Reactivate the term
    const updatedTerm = await this.prisma.term.update({
      where: { id: termId },
      data: { status: TermStatus.ACTIVE },
    });

    // Ensure the session is active
    await this.prisma.academicSession.update({
      where: { id: term.academicSessionId },
      data: { status: SessionStatus.ACTIVE },
    });

    this.logger.log(`Term ${term.name} reactivated for school ${school.id}`);

    return {
      term: await this.toTermDto(updatedTerm, school.id),
    };
  }

  /**
   * Get all sessions for a school (optionally filtered by school type)
   */
  async getSessions(schoolId: string, schoolType?: string): Promise<AcademicSessionDto[]> {
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    const sessions = await this.prisma.academicSession.findMany({
      where: {
        schoolId: school.id,
        schoolType: schoolType || null,
      },
      include: {
        terms: {
          orderBy: {
            number: 'asc',
          },
        },
      },
      orderBy: {
        startDate: 'desc',
      },
    });

    const opts = await this.getTermMapOptions(school.id);
    return sessions.map((s) => this.mapToSessionDto(s, opts));
  }

  private async getTermMapOptions(schoolId?: string): Promise<{
    workingDays: WorkingDay[];
    examBlackoutEnabled: boolean;
  }> {
    if (!schoolId) {
      return { workingDays: DEFAULT_WORKING_DAYS_FOR_TERM, examBlackoutEnabled: true };
    }
    try {
      const [days, policy] = await Promise.all([
        this.schoolSettingsService.getWorkingDays(schoolId),
        this.schoolSettingsService.getTimetablePolicy(schoolId),
      ]);
      return {
        workingDays: (days?.length ? days : DEFAULT_WORKING_DAYS_FOR_TERM) as WorkingDay[],
        examBlackoutEnabled: policy.examBlackoutEnabled !== false,
      };
    } catch {
      return { workingDays: DEFAULT_WORKING_DAYS_FOR_TERM, examBlackoutEnabled: true };
    }
  }

  private async toTermDto(term: any, schoolId?: string): Promise<TermDto> {
    const sid = schoolId ?? term.academicSession?.schoolId;
    return this.mapToTermDto(term, await this.getTermMapOptions(sid));
  }

  private async toSessionDto(session: any): Promise<AcademicSessionDto> {
    return this.mapToSessionDto(session, await this.getTermMapOptions(session.schoolId));
  }

  private mapToSessionDto(
    session: any,
    opts?: { workingDays: WorkingDay[]; examBlackoutEnabled: boolean },
  ): AcademicSessionDto {
    return {
      id: session.id,
      name: session.name,
      startDate: session.startDate,
      endDate: session.endDate,
      status: session.status,
      schoolId: session.schoolId,
      schoolType: session.schoolType,
      terms: session.terms ? session.terms.map((t: any) => this.mapToTermDto(t, opts)) : [],
      createdAt: session.createdAt,
    };
  }

  private mapToTermDto(
    term: any,
    opts?: { workingDays: WorkingDay[]; examBlackoutEnabled: boolean },
  ): TermDto {
    const now = new Date();
    const termStart = new Date(term.startDate);
    const termEnd = new Date(term.endDate);
    const workingDays = opts?.workingDays?.length ? opts.workingDays : DEFAULT_WORKING_DAYS_FOR_TERM;
    const examBlackoutEnabled = opts?.examBlackoutEnabled !== false;

    const msPerWeek = 7 * 24 * 60 * 60 * 1000;
    const totalWeeks = Math.max(1, Math.ceil((termEnd.getTime() - termStart.getTime()) / msPerWeek));

    const halfTerm = buildHalfTermRange(term.halfTermStart, term.halfTermEnd);
    const teaching = getTeachingWeekInfo(termStart, termEnd, now, {
      workingDays,
      nonInstructionalRanges: halfTerm ? [halfTerm] : [],
    });

    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const startOfTermEnd = new Date(termEnd);
    startOfTermEnd.setHours(0, 0, 0, 0);
    const daysRemaining = Math.ceil(
      (startOfTermEnd.getTime() - startOfToday.getTime()) / (1000 * 60 * 60 * 24),
    );
    const isPastEndDate = daysRemaining < 0;
    const startOfTermStart = new Date(termStart);
    startOfTermStart.setHours(0, 0, 0, 0);
    const isInSession =
      startOfToday.getTime() >= startOfTermStart.getTime() &&
      startOfToday.getTime() <= startOfTermEnd.getTime();
    const isOperationallyActive = term.status === TermStatus.ACTIVE && isInSession;
    const phaseInput = {
      startDate: termStart,
      endDate: termEnd,
      status: term.status,
      examStart: term.examStart,
      examEnd: term.examEnd,
      examTimetablePublishedAt: term.examTimetablePublishedAt,
    };
    const termPhase = getTermPhase(phaseInput, now);
    const isInExamPeriod = isExamScheduleActive(phaseInput, now);
    const isLessonScheduleActiveNow = isLessonScheduleActive(
      phaseInput,
      now,
      examBlackoutEnabled,
    );

    // Calendar weeks (legacy) — freeze at term end when still ACTIVE but overdue
    let currentWeek: number | undefined;
    if (term.status === TermStatus.ACTIVE && termStart <= now && isInSession) {
      currentWeek = Math.max(1, Math.floor((now.getTime() - termStart.getTime()) / msPerWeek) + 1);
      currentWeek = Math.min(currentWeek, totalWeeks);
    } else if (term.status === TermStatus.ACTIVE && isPastEndDate) {
      currentWeek = totalWeeks;
    }

    let currentTeachingWeek: number | undefined;
    if (term.status === TermStatus.ACTIVE && termStart <= now && isInSession) {
      currentTeachingWeek = teaching.currentTeachingWeek;
    } else if (term.status === TermStatus.ACTIVE && isPastEndDate) {
      currentTeachingWeek = teaching.totalTeachingWeeks;
    }

    return {
      id: term.id,
      name: term.name,
      number: term.number,
      startDate: term.startDate,
      endDate: term.endDate,
      halfTermStart: term.halfTermStart,
      halfTermEnd: term.halfTermEnd,
      midtermStart: term.midtermStart,
      midtermEnd: term.midtermEnd,
      examStart: term.examStart,
      examEnd: term.examEnd,
      examTimetablePublishedAt: term.examTimetablePublishedAt,
      status: term.status,
      academicSessionId: term.academicSessionId,
      currentWeek,
      totalWeeks,
      currentTeachingWeek,
      totalTeachingWeeks: teaching.totalTeachingWeeks,
      daysRemaining,
      isPastEndDate,
      isOperationallyActive,
      isInExamPeriod,
      isLessonScheduleActive: isLessonScheduleActiveNow,
      termPhase,
      createdAt: term.createdAt,
    };
  }

  /**
   * Idempotent seed of Nigerian public holidays as HOLIDAY events for a session window.
   */
  private async seedNigerianHolidaysForSession(
    schoolId: string,
    startDate: Date,
    endDate: Date,
    schoolType?: string | null,
  ): Promise<void> {
    try {
      const seeds = buildNigerianHolidayEvents(startDate, endDate);
      const existing = await (this.prisma as any).event.findMany({
        where: {
          schoolId,
          type: EventType.HOLIDAY,
          startDate: { gte: startDate, lte: endDate },
        },
        select: { title: true, startDate: true },
      });
      const keys = new Set(
        existing.map(
          (e: { title: string; startDate: Date }) =>
            `${e.title}|${e.startDate.toISOString().slice(0, 10)}`,
        ),
      );

      for (const seed of seeds) {
        const key = `${seed.title}|${seed.startDate.toISOString().slice(0, 10)}`;
        if (keys.has(key)) continue;
        await (this.prisma as any).event.create({
          data: {
            title: seed.title,
            description: seed.description,
            startDate: seed.startDate,
            endDate: seed.endDate,
            type: EventType.HOLIDAY,
            schoolType: schoolType || null,
            schoolId,
            isAllDay: true,
            syncStatus: 'PENDING',
          },
        });
        keys.add(key);
      }
    } catch (err) {
      this.logger.warn(
        `Failed to seed Nigerian holidays for school ${schoolId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Build date ranges for terms. Uses custom termDates if provided,
   * otherwise auto-calculates equal-split ranges (preserving existing behavior).
   */
  private buildTermDateRanges(
    sessionStart: Date,
    sessionEnd: Date,
    termCount: number,
    customTermDates?: TermDateDto[],
  ): Array<{ number: number; startDate: Date; endDate: Date }> {
    // If custom dates are provided, validate and use them
    if (customTermDates && customTermDates.length > 0) {
      // Validate we have the right count
      if (customTermDates.length !== termCount) {
        throw new BadRequestException(
          `Expected ${termCount} term date entries but received ${customTermDates.length}.`
        );
      }

      // Validate each term's dates
      const ranges = customTermDates
        .sort((a, b) => a.number - b.number)
        .map((td) => {
          const start = new Date(td.startDate);
          const end = new Date(td.endDate);

          if (start >= end) {
            throw new BadRequestException(
              `Term ${td.number}: start date must be before end date.`
            );
          }

          if (start < sessionStart || end > sessionEnd) {
            throw new BadRequestException(
              `Term ${td.number}: dates must be within the session period ` +
              `(${sessionStart.toISOString().split('T')[0]} to ${sessionEnd.toISOString().split('T')[0]}).`
            );
          }

          return { number: td.number, startDate: start, endDate: end };
        });

      return ranges;
    }

    // Default: auto-calculate equal splits (preserves existing behavior)
    const sessionDurationMs = sessionEnd.getTime() - sessionStart.getTime();
    const termDurationMs = sessionDurationMs / termCount;
    const ranges: Array<{ number: number; startDate: Date; endDate: Date }> = [];

    for (let i = 0; i < termCount; i++) {
      const termStart = i === 0
        ? new Date(sessionStart)
        : new Date(sessionStart.getTime() + termDurationMs * i + 1);
      const termEnd = i === termCount - 1
        ? new Date(sessionEnd)
        : new Date(sessionStart.getTime() + termDurationMs * (i + 1));

      ranges.push({ number: i + 1, startDate: termStart, endDate: termEnd });
    }

    return ranges;
  }

  /**
   * Update session dates after creation.
   * Start date changes allowed before session start or within SESSION_START_GRACE_DAYS.
   */
  async updateSessionDates(
    schoolId: string,
    sessionId: string,
    dto: UpdateSessionDatesDto,
  ): Promise<AcademicSessionDto> {
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }
    await this.schoolValidator.validateSchoolActive(school.id);

    const session = await this.prisma.academicSession.findFirst({
      where: { id: sessionId, schoolId: school.id },
      include: { terms: { orderBy: { number: 'asc' } } },
    });

    if (!session) {
      throw new NotFoundException('Academic session not found');
    }

    if (session.status !== SessionStatus.ACTIVE) {
      throw new BadRequestException('Only active sessions can have their dates adjusted');
    }

    const now = new Date();
    const originalStart = new Date(session.startDate);
    const newStart = dto.startDate ? new Date(dto.startDate) : session.startDate;
    const newEnd = dto.endDate ? new Date(dto.endDate) : session.endDate;

    if (newStart >= newEnd) {
      throw new BadRequestException('Start date must be before end date');
    }

    const monthsDiff =
      (newEnd.getFullYear() - newStart.getFullYear()) * 12 +
      (newEnd.getMonth() - newStart.getMonth());
    const daysDiff = Math.floor((newEnd.getTime() - newStart.getTime()) / (1000 * 60 * 60 * 24));

    if (monthsDiff < 10 || daysDiff < 300) {
      throw new BadRequestException(
        'An academic session must span at least 10 months (approximately one year).'
      );
    }
    if (monthsDiff > 12 || daysDiff > 370) {
      throw new BadRequestException('An academic session cannot exceed 12 months.');
    }

    if (dto.startDate && newStart.getTime() !== originalStart.getTime()) {
      const gracePeriodEnd = new Date(originalStart);
      gracePeriodEnd.setDate(gracePeriodEnd.getDate() + SESSION_START_GRACE_DAYS);
      if (now > gracePeriodEnd) {
        throw new BadRequestException(
          'Session start date can only be adjusted before the session starts or within the first week of the session.'
        );
      }
    }

    for (const term of session.terms) {
      if (term.status === TermStatus.COMPLETED || term.status === TermStatus.ARCHIVED) {
        if (new Date(term.startDate) < newStart || new Date(term.endDate) > newEnd) {
          throw new BadRequestException(
            `Cannot change session dates: ${term.name} is completed and would fall outside the new session period.`
          );
        }
      }
    }

    for (const term of session.terms) {
      if (term.status === TermStatus.ACTIVE) {
        if (new Date(term.startDate) < newStart || new Date(term.endDate) > newEnd) {
          throw new BadRequestException(
            `Cannot change session dates: ${term.name} would fall outside the new session period. Adjust term dates first.`
          );
        }
      }
    }

    const recalibrate = dto.recalibrateTerms === RecalibrateTermsMode.DRAFT_ONLY;

    if (!recalibrate) {
      for (const term of session.terms) {
        if (term.status === TermStatus.DRAFT) {
          if (new Date(term.startDate) < newStart || new Date(term.endDate) > newEnd) {
            throw new BadRequestException(
              `Cannot change session dates: ${term.name} would fall outside the new session period. Enable recalibrate draft terms or adjust manually.`
            );
          }
        }
      }
    }

    await this.prisma.academicSession.update({
      where: { id: sessionId },
      data: {
        ...(dto.startDate && { startDate: newStart }),
        ...(dto.endDate && { endDate: newEnd }),
      },
    });

    if (recalibrate) {
      const isTertiary = session.schoolType === 'TERTIARY';
      const termCount = isTertiary ? 2 : 3;
      const ranges = this.buildTermDateRanges(newStart, newEnd, termCount);

      for (const range of ranges) {
        const term = session.terms.find((t) => t.number === range.number);
        if (!term || term.status !== TermStatus.DRAFT) continue;

        await this.prisma.term.update({
          where: { id: term.id },
          data: {
            startDate: range.startDate,
            endDate: range.endDate,
            halfTermStart: null,
            halfTermEnd: null,
            midtermStart: null,
            midtermEnd: null,
            examStart: null,
            examEnd: null,
            examTimetablePublishedAt: null,
            examTimetablePublishedBy: null,
          } as any,
        });
      }
    }

    if (dto.startDate || dto.endDate) {
      await this.seedNigerianHolidaysForSession(
        school.id,
        newStart,
        newEnd,
        session.schoolType,
      );
    }

    const updated = await this.prisma.academicSession.findUnique({
      where: { id: sessionId },
      include: { terms: { orderBy: { number: 'asc' } } },
    });

    return this.toSessionDto(updated!);
  }

  /**
   * Update term dates after creation.
   * Validates new dates are within the parent session's date range.
   */
  async updateTermDates(
    schoolId: string,
    sessionId: string,
    termId: string,
    dto: UpdateTermDatesDto,
  ): Promise<TermDto> {
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    const term = await this.prisma.term.findFirst({
      where: {
        id: termId,
        academicSessionId: sessionId,
        academicSession: { schoolId: school.id },
      },
      include: { academicSession: true },
    });

    if (!term) {
      throw new NotFoundException('Term not found');
    }

    // Guard: Block editing of COMPLETED or ARCHIVED terms
    if (term.status === TermStatus.COMPLETED || term.status === TermStatus.ARCHIVED) {
      throw new BadRequestException(
        'Cannot modify dates of a completed or archived term. ' +
        'Only ACTIVE or DRAFT terms can have their dates adjusted.'
      );
    }

    const now = new Date();
    const originalStart = new Date(term.startDate);
    const newStart = dto.startDate ? new Date(dto.startDate) : term.startDate;
    const newEnd = dto.endDate ? new Date(dto.endDate) : term.endDate;

    // Validation 1: Start date must be before end date
    if (newStart >= newEnd) {
      throw new BadRequestException('Start date must be before end date');
    }

    // Validation 2: Term dates must be within session dates
    if (newStart < term.academicSession.startDate || newEnd > term.academicSession.endDate) {
      throw new BadRequestException('Term dates must be within session dates');
    }

    // Validation 3: Start date adjustment restriction
    // Only allow adjustment pre-term or up to 1 week after it has started
    if (dto.startDate && newStart.getTime() !== originalStart.getTime()) {
      const gracePeriodEnd = new Date(originalStart);
      gracePeriodEnd.setDate(gracePeriodEnd.getDate() + 7);

      if (now > gracePeriodEnd) {
        throw new BadRequestException(
          'Term start date can only be adjusted before the term starts or within the first week of the term. ' +
          'This is to ensure the integrity of academic records and student progression.'
        );
      }
    }

    const unpublishExamTimetable =
      term.examTimetablePublishedAt &&
      (dto.examStart !== undefined || dto.examEnd !== undefined);

    const updated = await this.prisma.term.update({
      where: { id: termId },
      data: {
        ...(dto.startDate && { startDate: newStart }),
        ...(dto.endDate && { endDate: newEnd }),
        ...(dto.halfTermStart !== undefined && { halfTermStart: dto.halfTermStart ? new Date(dto.halfTermStart) : null }),
        ...(dto.halfTermEnd !== undefined && { halfTermEnd: dto.halfTermEnd ? new Date(dto.halfTermEnd) : null }),
        ...(dto.midtermStart !== undefined && { midtermStart: dto.midtermStart ? new Date(dto.midtermStart) : null }),
        ...(dto.midtermEnd !== undefined && { midtermEnd: dto.midtermEnd ? new Date(dto.midtermEnd) : null }),
        ...(dto.examStart !== undefined && { examStart: dto.examStart ? new Date(dto.examStart) : null }),
        ...(dto.examEnd !== undefined && { examEnd: dto.examEnd ? new Date(dto.examEnd) : null }),
        ...(unpublishExamTimetable && {
          examTimetablePublishedAt: null,
          examTimetablePublishedBy: null,
        }),
      } as any,
    });

    return this.toTermDto(updated, term.academicSession?.schoolId);
  }

  /**
   * Get all school members (admins, teachers, students) with email addresses
   */
  private async getSchoolMembers(
    schoolId: string,
    schoolType?: string | null
  ): Promise<
    Array<{
      email: string;
      name: string;
      role: string;
    }>
  > {
    const members: Array<{ email: string; name: string; role: string }> = [];

    // Get school admins
    const admins = await this.prisma.schoolAdmin.findMany({
      where: { schoolId },
      include: { user: true },
    });

    for (const admin of admins) {
      if (admin.user?.email) {
        members.push({
          email: admin.user.email,
          name: `${admin.firstName} ${admin.lastName}`,
          role: admin.role || 'School Administrator',
        });
      }
    }

    // Get teachers
    const teachers = await this.prisma.teacher.findMany({
      where: { schoolId },
      include: { user: true },
    });

    for (const teacher of teachers) {
      const email = teacher.user?.email || teacher.email;
      if (email) {
        members.push({
          email,
          name: `${teacher.firstName} ${teacher.lastName}`,
          role: 'Teacher',
        });
      }
    }

    // Get students (optionally filtered by school type via class level)
    const students = await this.prisma.student.findMany({
      where: {
        enrollments: {
          some: {
            schoolId,
            isActive: true,
          },
        },
      },
      include: {
        user: true,
        enrollments: {
          where: {
            schoolId,
            isActive: true,
          },
          include: {
            class: true,
          },
        },
      },
    });

    for (const student of students) {
      // If schoolType is specified, filter students
      if (schoolType) {
        const enrollment = student.enrollments[0];
        if (enrollment) {
          // Check if student is in this school type
          const classType = enrollment.class?.type;
          const levelStr = enrollment.classLevel?.toUpperCase() || '';

          let matchesType = false;
          if (classType === schoolType) {
            matchesType = true;
          } else if (!classType) {
            // Infer from classLevel
            if (schoolType === 'PRIMARY') {
              matchesType = levelStr.includes('CLASS') || levelStr.includes('PRIMARY');
            } else if (schoolType === 'SECONDARY') {
              matchesType = levelStr.includes('JSS') || levelStr.includes('SS');
            } else if (schoolType === 'TERTIARY') {
              matchesType =
                /\d+L/.test(levelStr) || levelStr.includes('LEVEL') || levelStr.includes('YEAR');
            }
          }

          if (!matchesType) continue;
        }
      }

      if (student.user?.email) {
        members.push({
          email: student.user.email,
          name: `${student.firstName} ${student.lastName}`,
          role: 'Student',
        });
      }
    }

    return members;
  }

  /**
   * Send session/term start notification emails to all school members
   */
  private async sendSessionTermNotifications(
    schoolId: string,
    schoolName: string,
    sessionName: string,
    termName: string,
    startDate: Date,
    endDate: Date,
    isNewSession: boolean,
    schoolType?: string | null
  ): Promise<void> {
    try {
      const members = await this.getSchoolMembers(schoolId, schoolType);

      if (members.length === 0) {
        this.logger.log('No school members found to notify');
        return;
      }

      this.logger.log(
        `Sending ${isNewSession ? 'session' : 'term'} notifications to ${members.length} members`
      );

      // Send emails in background (don't await)
      this.emailService
        .sendBulkEmails(
          members.map((m) => ({ to: m.email, name: m.name, role: m.role })),
          isNewSession ? 'session' : 'term',
          sessionName,
          termName,
          startDate,
          endDate,
          schoolName,
          schoolId,
        )
        .then((result) => {
          this.logger.log(
            `Session/term notifications: ${result.sent} sent, ${result.failed} failed`
          );
        })
        .catch((error) => {
          this.logger.error('Failed to send session/term notifications:', error);
        });

      // In-app + push for all school members
      void this.fanOutSessionTermInbox(
        schoolId,
        schoolName,
        sessionName,
        termName,
        isNewSession,
      );
    } catch (error) {
      this.logger.error('Error preparing session/term notifications:', error);
    }
  }

  private async fanOutSessionTermInbox(
    schoolId: string,
    schoolName: string,
    sessionName: string,
    termName: string,
    isNewSession: boolean,
  ) {
    try {
      const members = await this.notificationInbox.getAllSchoolMemberUserIds(schoolId);
      const type = isNewSession ? 'SESSION_STARTED' : 'TERM_STARTED';
      const title = isNewSession ? 'New session started' : 'New term started';
      const subtitle = isNewSession ? sessionName : termName;
      const body = isNewSession
        ? `${sessionName} has started at ${schoolName}. ${termName} is the current term.`
        : `${termName} of ${sessionName} has started at ${schoolName}.`;

      const inputs = [
        ...members.admins.map((userId) => ({
          userId,
          schoolId,
          role: 'SCHOOL_ADMIN' as const,
          type,
          title,
          subtitle,
          body,
          link: '/dashboard/school/settings/session',
        })),
        ...members.teachers.map((userId) => ({
          userId,
          schoolId,
          role: 'TEACHER' as const,
          type,
          title,
          subtitle,
          body,
          link: '/dashboard/teacher/calendar',
        })),
        ...members.students.map((userId) => ({
          userId,
          schoolId,
          role: 'STUDENT' as const,
          type,
          title,
          subtitle,
          body,
          link: '/dashboard/student/overview',
        })),
      ];
      await this.notificationInbox.createAndFanOut(inputs);
    } catch (err: any) {
      this.logger.warn(`In-app session/term notify failed: ${err?.message || err}`);
    }
  }

  /** Daily: remind when an active term ends within 7 days */
  @Cron(CronExpression.EVERY_DAY_AT_8AM)
  async checkTermEndingReminders() {
    const now = new Date();
    const in7 = new Date(now);
    in7.setDate(in7.getDate() + 7);

    const terms = await this.prisma.term.findMany({
      where: {
        status: TermStatus.ACTIVE,
        endDate: { gte: now, lte: in7 },
      },
      include: { academicSession: { include: { school: { select: { name: true } } } } },
    });

    for (const term of terms) {
      const schoolId = term.academicSession.schoolId;
      const schoolName = term.academicSession.school?.name || 'your school';
      const daysLeft = Math.ceil(
        (term.endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
      );
      const members = await this.notificationInbox.getAllSchoolMemberUserIds(schoolId);
      const title = 'Term ending soon';
      const subtitle = term.name;
      const body = `${term.name} at ${schoolName} ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`;
      const type = 'TERM_ENDING_SOON';
      try {
        await this.notificationInbox.createAndFanOut([
          ...members.admins.map((userId) => ({
            userId,
            schoolId,
            role: 'SCHOOL_ADMIN',
            type,
            title,
            subtitle,
            body,
            link: '/dashboard/school/settings/session',
            metadata: { termId: term.id, daysLeft },
          })),
          ...members.teachers.map((userId) => ({
            userId,
            schoolId,
            role: 'TEACHER',
            type,
            title,
            subtitle,
            body,
            link: '/dashboard/teacher/calendar',
            metadata: { termId: term.id, daysLeft },
          })),
          ...members.students.map((userId) => ({
            userId,
            schoolId,
            role: 'STUDENT',
            type,
            title,
            subtitle,
            body,
            link: '/dashboard/student/overview',
            metadata: { termId: term.id, daysLeft },
          })),
        ]);
      } catch (err: any) {
        this.logger.warn(`Term ending reminder failed for ${term.id}: ${err?.message || err}`);
      }
    }
  }

  /**
   * Send promotion emails to promoted students
   */
  private async sendPromotionEmails(
    promotedStudents: Array<{
      email: string;
      name: string;
      previousClass: string;
      newClass: string;
    }>,
    sessionName: string,
    schoolName: string
  ): Promise<void> {
    if (promotedStudents.length === 0) return;

    this.logger.log(`Sending promotion emails to ${promotedStudents.length} students`);

    // Process in batches
    const batchSize = 10;
    for (let i = 0; i < promotedStudents.length; i += batchSize) {
      const batch = promotedStudents.slice(i, i + batchSize);

      await Promise.all(
        batch.map(async (student) => {
          try {
            await this.emailService.sendStudentPromotionEmail(
              student.email,
              student.name,
              student.previousClass,
              student.newClass,
              sessionName,
              schoolName
            );
          } catch (error) {
            this.logger.error(`Failed to send promotion email to ${student.email}`);
          }
        })
      );

      // Small delay between batches
      if (i + batchSize < promotedStudents.length) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }
}
