import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../database/prisma.service';
import { SchoolRepository } from '../schools/domain/repositories/school.repository';
import {
  CreateTimetablePeriodDto,
  CreateMasterScheduleDto,
  ReplaceTimetableDto,
} from './dto/create-timetable-period.dto';
import { TimetablePeriodDto, ConflictInfo } from './dto/timetable.dto';
import { DayOfWeek, PeriodType } from './dto/create-timetable-period.dto';
import { NotificationInboxService } from '../notification/notification-inbox.service';

/**
 * Service for managing timetables with conflict detection
 */
@Injectable()
export class TimetableService {
  private readonly logger = new Logger(TimetableService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly schoolRepository: SchoolRepository,
    private readonly notificationInbox: NotificationInboxService,
  ) { }

  // Access Prisma models using bracket notation for reserved keywords
  private get timetablePeriodModel() {
    return (this.prisma as any)['timetablePeriod'];
  }

  /**
   * Create a timetable period with conflict detection
   */
  async createPeriod(schoolId: string, dto: CreateTimetablePeriodDto): Promise<TimetablePeriodDto> {
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    // Validate term exists and belongs to school
    const term = await this.prisma.term.findUnique({
      where: { id: dto.termId },
      include: { academicSession: true },
    });

    if (!term || term.academicSession.schoolId !== school.id) {
      throw new NotFoundException('Term not found');
    }

    // Validate either classId or classArmId is provided
    if (!dto.classId && !dto.classArmId) {
      throw new BadRequestException('Either classId or classArmId must be provided');
    }

    // Validate class exists if classId is provided
    if (dto.classId) {
      const classData = await this.prisma.class.findUnique({
        where: { id: dto.classId },
      });

      if (!classData || classData.schoolId !== school.id) {
        throw new NotFoundException('Class not found');
      }
    }

    // Validate class arm exists if classArmId is provided
    let classArmForPeriod: { classLevel: { type: string; schoolId: string } } | null = null;
    if (dto.classArmId) {
      classArmForPeriod = await this.prisma.classArm.findUnique({
        where: { id: dto.classArmId },
        include: { classLevel: true },
      });

      if (!classArmForPeriod || classArmForPeriod.classLevel.schoolId !== school.id) {
        throw new NotFoundException('Class arm not found');
      }
    }

    // Check for conflicts
    const conflict = await this.detectConflicts(dto, school.id);
    if (conflict) {
      throw new ConflictException(conflict.message);
    }

    // Validate time format
    this.validateTimeFormat(dto.startTime);
    this.validateTimeFormat(dto.endTime);

    // Validate time range
    if (dto.startTime >= dto.endTime) {
      throw new BadRequestException('Start time must be before end time');
    }

    // REQ-P3: For PRIMARY LESSON periods with no explicit teacherId, auto-fill the class teacher
    let resolvedTeacherId = dto.teacherId || null;
    if (dto.classArmId && !dto.teacherId && classArmForPeriod) {
      const periodType = dto.type || PeriodType.LESSON;
      if (classArmForPeriod.classLevel.type === 'PRIMARY' && periodType === PeriodType.LESSON) {
        resolvedTeacherId = await this.resolvePrimaryTeacher(dto.classArmId);
      }
    }

    // Create period
    const period = await this.timetablePeriodModel.create({
      data: {
        dayOfWeek: dto.dayOfWeek,
        startTime: dto.startTime,
        endTime: dto.endTime,
        type: dto.type || PeriodType.LESSON,
        subjectId: dto.subjectId || null,
        courseId: dto.courseId || null,
        teacherId: resolvedTeacherId,
        roomId: dto.roomId || null,
        classId: dto.classId || null,
        classArmId: dto.classArmId || null,
        termId: dto.termId,
      },
      include: {
        subject: true,
        course: true,
        class: true,
        teacher: true,
        room: true,
        classArm: {
          include: {
            classLevel: true,
          },
        },
      },
    });

    const periodDto = this.mapToPeriodDto(period);

    void this.notifyTimetableChange(schoolId, {
      classId: dto.classId,
      classArmId: dto.classArmId,
      teacherId: resolvedTeacherId || undefined,
    });

    // REQ-2 + REQ-3: For SECONDARY periods with a subject, classArm, and teacher —
    // sync the ClassTeacher record and warn if it diverges from an existing designation.
    const warnings: string[] = [];
    if (
      period.subjectId &&
      period.classArmId &&
      period.teacherId &&
      period.type === 'LESSON'
    ) {
      warnings.push(...(await this.syncClassTeacherFromPeriod(period)));
    }

    if (warnings.length > 0) {
      (periodDto as any).warnings = warnings;
    }

    return periodDto;
  }

  /**
   * REQ-2 + REQ-3: Sync a ClassTeacher record from a timetable period.
   * - If no ClassTeacher exists for (classArmId, subjectId, sessionId), create one.
   * - If one exists with a DIFFERENT teacher, update it (timetable is source of truth)
   *   and return a warning message.
   * - Returns an array of warning strings (empty if no mismatch).
   */
  private async syncClassTeacherFromPeriod(period: any): Promise<string[]> {
    const warnings: string[] = [];

    // Only applies to SECONDARY class arms
    const classArm = await this.prisma.classArm.findUnique({
      where: { id: period.classArmId },
      include: { classLevel: true },
    });
    if (!classArm || classArm.classLevel.type !== 'SECONDARY') {
      return warnings;
    }

    // Find the active session for this term
    const term = await this.prisma.term.findUnique({
      where: { id: period.termId },
      include: { academicSession: true },
    });
    if (!term) return warnings;

    const sessionId = term.academicSessionId;
    const { subjectId, classArmId, teacherId } = period;

    const existing = await this.prisma.classTeacher.findFirst({
      where: { subjectId, classArmId, sessionId },
      include: {
        teacher: { select: { firstName: true, lastName: true } },
        subjectRef: { select: { name: true } },
        classArm: { include: { classLevel: { select: { name: true } } } },
      },
    });

    if (!existing) {
      // No assignment yet — create one
      await this.prisma.classTeacher.upsert({
        where: {
          classArmId_subjectId_sessionId: { classArmId, subjectId, sessionId },
        },
        create: {
          classArmId,
          subjectId,
          sessionId,
          teacherId,
          isPrimary: false,
          isFormTeacher: false,
        },
        update: { teacherId },
      });
    } else if (existing.teacherId !== teacherId) {
      // Mismatch — update to match timetable and warn
      const oldTeacherName = existing.teacher
        ? `${existing.teacher.firstName} ${existing.teacher.lastName}`
        : existing.teacherId;
      const subjectName = existing.subjectRef?.name || subjectId;
      const className = existing.classArm
        ? `${existing.classArm.classLevel.name} ${existing.classArm.name}`
        : classArmId;

      await this.prisma.classTeacher.update({
        where: { id: existing.id },
        data: { teacherId },
      });

      warnings.push(
        `Class assignment updated: "${subjectName}" in ${className} was designated to ${oldTeacherName}. ` +
          `Timetable assignment has been synced to the new teacher.`
      );
    }
    // If existing.teacherId === teacherId, no action needed

    return warnings;
  }

  /**
   * REQ-P3: Resolve the primary class teacher for a PRIMARY class arm.
   * Returns the teacherId of the ClassTeacher with isPrimary=true, or null if none exists.
   */
  private async resolvePrimaryTeacher(classArmId: string): Promise<string | null> {
    const ct = await this.prisma.classTeacher.findFirst({
      where: { classArmId, isPrimary: true },
      select: { teacherId: true },
    });
    return ct?.teacherId ?? null;
  }

  async createMasterSchedule(
    schoolId: string,
    dto: CreateMasterScheduleDto
  ): Promise<{ created: number; skipped: number }> {
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    // Validate term
    const term = await this.prisma.term.findUnique({
      where: { id: dto.termId },
      include: { academicSession: true },
    });

    if (!term || term.academicSession.schoolId !== school.id) {
      throw new NotFoundException('Term not found');
    }

    let targets: Array<{ classId?: string; classArmId?: string }> = [];

    if (dto.classId) {
      // Validate class exists
      const classData = await this.prisma.class.findUnique({
        where: { id: dto.classId },
      });
      if (!classData || classData.schoolId !== school.id) {
        throw new NotFoundException('Class not found');
      }
      targets.push({ classId: dto.classId });
    } else if (dto.classArmId) {
      // Validate class arm exists
      const classArm = await this.prisma.classArm.findUnique({
        where: { id: dto.classArmId },
        include: { classLevel: true },
      });
      if (!classArm || classArm.classLevel.schoolId !== school.id) {
        throw new NotFoundException('Class arm not found');
      }
      targets.push({ classArmId: dto.classArmId });
    } else {
      // Fallback: Get all active class arms for the school
      const classArms = await this.prisma.classArm.findMany({
        where: {
          classLevel: {
            schoolId: school.id,
          },
          isActive: true,
        },
      });
      targets = classArms.map((ca) => ({ classArmId: ca.id }));
    }

    const periodsToCreate: any[] = [];

    for (const target of targets) {
      for (const periodDef of dto.periods) {
        periodsToCreate.push({
          dayOfWeek: periodDef.dayOfWeek,
          startTime: periodDef.startTime,
          endTime: periodDef.endTime,
          type: periodDef.type || PeriodType.LESSON,
          classId: target.classId || null,
          classArmId: target.classArmId || null,
          termId: dto.termId,
        });
      }
    }

    let created = 0;
    let skipped = 0;

    if (periodsToCreate.length > 0) {
      const result = await this.timetablePeriodModel.createMany({
        data: periodsToCreate,
        skipDuplicates: true,
      });

      created = result.count;
      skipped = periodsToCreate.length - created;
    }

    return { created, skipped };
  }

  /**
   * Get timetable for a class arm
   */
  async getTimetableForClassArm(
    schoolId: string,
    classArmId: string,
    termId: string
  ): Promise<TimetablePeriodDto[]> {
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    const periods = await this.timetablePeriodModel.findMany({
      where: {
        classArmId: classArmId,
        termId: termId,
      },
      include: {
        subject: true,
        course: true,
        class: true,
        teacher: true,
        room: true,
        classArm: {
          include: {
            classLevel: true,
          },
        },
      },
      orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
    });

    return periods.map((p: any) => this.mapToPeriodDto(p));
  }

  /**
   * Get timetable for a teacher
   * Returns all periods where the teacher is assigned, grouped by day
   * Includes:
   * 1. Periods where teacherId is explicitly set
   * 2. Periods for classes where teacher is assigned (via ClassTeacher)
   *    - For PRIMARY: All periods for assigned classes
   *    - For SECONDARY: Periods where subject matches teacher's assignment
   *    - For TERTIARY: Periods for assigned courses
   */
  async getTimetableForTeacher(
    schoolId: string,
    teacherId: string,
    termId: string
  ): Promise<TimetablePeriodDto[]> {
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    // Validate teacher exists and belongs to school
    // Note: teacherId parameter can be either the database id or the unique teacherId field
    const teacher = await this.prisma.teacher.findFirst({
      where: {
        OR: [{ id: teacherId }, { teacherId: teacherId }],
        schoolId: school.id,
      },
      include: {
        classTeachers: {
          include: {
            class: true,
            classArm: {
              include: {
                classLevel: true,
              },
            },
          },
        },
      },
    });

    if (!teacher) {
      throw new NotFoundException('Teacher not found');
    }

    // Build conditions for periods where teacher is assigned
    const orConditions: any[] = [
      // Periods where teacherId is explicitly set to this teacher
      // This covers SECONDARY timetable-based assignments and any direct teacher assignment
      { teacherId: teacher.id },
    ];

    // Add conditions for each class/classArm assignment based on school type
    for (const ct of teacher.classTeachers) {
      if (ct.classArmId && ct.classArm) {
        const classType = ct.classArm.classLevel?.type;

        if (classType === 'PRIMARY') {
          // PRIMARY: The class teacher teaches ALL subjects in this class,
          // so include every period for the full class timetable
          orConditions.push({ classArmId: ct.classArmId });
        }
        // SECONDARY: Do NOT add classArmId here.
        // A form teacher does NOT teach every subject in their class.
        // Their teaching periods are already covered by the teacherId match above,
        // because the timetable links teachers to periods directly.
      } else if (ct.classId && ct.class) {
        if (ct.class.type === 'TERTIARY') {
          // TERTIARY: Match by courseId
          orConditions.push({ courseId: ct.classId });
        } else if (ct.class.type === 'PRIMARY') {
          // PRIMARY (legacy Class, not ClassArm): Include all periods
          orConditions.push({ classId: ct.classId });
        }
        // SECONDARY legacy Class — same principle: don't include all periods
      }
    }

    // Get all periods for this teacher
    const periods = await this.timetablePeriodModel.findMany({
      where: {
        termId: termId,
        OR: orConditions,
      },
      include: {
        subject: true,
        course: true,
        class: true,
        teacher: true,
        room: true,
        classArm: {
          include: {
            classLevel: true,
          },
        },
        term: true,
      },
      orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
    });

    return this.detectTimeConflicts(periods.map((p: any) => this.mapToPeriodDto(p)));
  }

  /**
   * Get timetable for a class or classArm
   * The classId parameter can be either a Class ID or a ClassArm ID
   */
  async getTimetableForClass(
    schoolId: string,
    classId: string,
    termId: string
  ): Promise<TimetablePeriodDto[]> {
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    // Check if this is a ClassArm ID first
    const classArm = await this.prisma.classArm.findUnique({
      where: { id: classId },
    });

    // Build where clause based on whether it's a ClassArm or Class
    const whereClause: any = {
      termId: termId,
    };

    if (classArm) {
      // It's a ClassArm ID
      whereClause.classArmId = classId;
    } else {
      // It's a Class ID - check both classId and courseId for TERTIARY
      whereClause.OR = [{ classId: classId }, { courseId: classId }];
    }

    const periods = await this.timetablePeriodModel.findMany({
      where: whereClause,
      include: {
        subject: true,
        course: true,
        class: true,
        teacher: true,
        room: true,
        classArm: {
          include: {
            classLevel: true,
          },
        },
      },
      orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
    });

    return periods.map((p: any) => this.mapToPeriodDto(p));
  }

  /**
   * Get timetable for a student (Hybrid approach for TERTIARY)
   * For PRIMARY/SECONDARY: Returns timetable for student's class level (existing logic)
   * For TERTIARY: Merges home class timetable + course registration subjects
   */
  async getTimetableForStudent(
    schoolId: string,
    studentId: string,
    termId: string
  ): Promise<TimetablePeriodDto[]> {
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    // Get student with enrollment
    const student = await this.prisma.student.findUnique({
      where: { id: studentId },
      include: {
        enrollments: {
          where: {
            schoolId: school.id,
            isActive: true,
          },
          include: {
            class: true,
            classArm: {
              include: {
                classLevel: true,
              },
            },
          },
          take: 1,
        },
      },
    });

    if (!student || student.enrollments.length === 0) {
      throw new NotFoundException('Student not found or not enrolled in this school');
    }

    const enrollment = student.enrollments[0];
    const classData = enrollment.class;

    // Check if this is a TERTIARY institution
    const isTertiary = school.hasTertiary && classData?.type === 'TERTIARY';

    if (!isTertiary) {
      // PRIMARY/SECONDARY: Check if enrollment has ClassArm (for schools using ClassArms)
      if (enrollment.classArmId && enrollment.classArm) {
        // School uses ClassArms - get timetable for ClassArm
        return this.getTimetableForClassArm(schoolId, enrollment.classArmId, termId);
      }
      // Fallback to Class timetable (for schools without ClassArms - backward compatibility)
      if (classData?.id) {
        return this.getTimetableForClass(schoolId, classData.id, termId);
      }
      // If no class either, return empty timetable
      return [];
    }

    // TERTIARY: Hybrid approach - merge home class timetable + course registrations
    const [homeClassTimetable, courseRegistrations] = await Promise.all([
      // 1. Get home class timetable (e.g., 400 Level)
      this.getTimetableForClass(schoolId, classData.id, termId),
      // 2. Get active course registrations for this student and term
      (this.prisma as any).courseRegistration.findMany({
        where: {
          studentId: student.id,
          termId: termId,
          isActive: true,
        },
        include: {
          subject: {
            select: {
              id: true,
              name: true,
              code: true,
            },
          },
        },
      }),
    ]);

    // 3. Get timetable slots for registered subjects (carry-overs)
    const registeredSubjectIds = courseRegistrations.map((cr: any) => cr.subjectId);
    let registeredSubjectTimetable: TimetablePeriodDto[] = [];

    if (registeredSubjectIds.length > 0) {
      const registeredPeriods = await this.timetablePeriodModel.findMany({
        where: {
          termId: termId,
          subjectId: { in: registeredSubjectIds },
        },
        include: {
          subject: true,
          course: true,
          class: true,
          teacher: true,
          room: true,
          classArm: {
            include: {
              classLevel: true,
            },
          },
        },
        orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
      });

      registeredSubjectTimetable = registeredPeriods.map((p: any) => {
        const dto = this.mapToPeriodDto(p);
        // Mark as from course registration
        (dto as any).isFromCourseRegistration = true;
        return dto;
      });
    }

    // 4. Merge both timetables
    const mergedTimetable = [...homeClassTimetable, ...registeredSubjectTimetable];

    // 5. Detect conflicts (time overlaps)
    const timetableWithConflicts = this.detectTimeConflicts(mergedTimetable);

    return timetableWithConflicts;
  }

  /**
   * Detect time conflicts in a merged timetable
   * Two periods conflict if they overlap in time on the same day
   */
  private detectTimeConflicts(periods: TimetablePeriodDto[]): TimetablePeriodDto[] {
    const periodsWithConflicts = periods.map((period) => ({ ...period }));

    for (let i = 0; i < periodsWithConflicts.length; i++) {
      const period1 = periodsWithConflicts[i];
      const conflicts: string[] = [];
      let conflictMessage = '';

      for (let j = i + 1; j < periodsWithConflicts.length; j++) {
        const period2 = periodsWithConflicts[j];

        // Check if periods are on the same day and overlap in time
        if (
          period1.dayOfWeek === period2.dayOfWeek &&
          this.doPeriodsOverlap(
            period1.startTime,
            period1.endTime,
            period2.startTime,
            period2.endTime
          )
        ) {
          conflicts.push(period2.id);
          const message = `${this.periodClashLabel(period1)} overlaps ${this.periodClashLabel(period2)} at ${period1.startTime} on ${this.formatDayLabel(period1.dayOfWeek)}`;
          period2.hasConflict = true;
          period2.conflictingPeriodIds = period2.conflictingPeriodIds || [];
          if (!period2.conflictingPeriodIds.includes(period1.id)) {
            period2.conflictingPeriodIds.push(period1.id);
          }
          period2.conflictMessage = period2.conflictMessage
            ? `${period2.conflictMessage} ${message}`
            : message;
          conflictMessage = conflictMessage ? `${conflictMessage} ${message}` : message;
        }
      }

      if (conflicts.length > 0) {
        period1.hasConflict = true;
        period1.conflictingPeriodIds = [
          ...new Set([...(period1.conflictingPeriodIds || []), ...conflicts]),
        ];
        if (conflictMessage && !period1.conflictMessage?.includes(conflictMessage)) {
          period1.conflictMessage = period1.conflictMessage
            ? `${period1.conflictMessage} ${conflictMessage}`
            : conflictMessage;
        }
      }
    }

    return periodsWithConflicts;
  }

  private periodClashLabel(period: TimetablePeriodDto): string {
    const subject = period.subjectName || period.courseName || 'Lesson';
    const cls = period.classArmName || period.className;
    return cls ? `${subject} in ${cls}` : subject;
  }

  private formatDayLabel(day: string): string {
    if (!day) return '';
    return day.charAt(0).toUpperCase() + day.slice(1).toLowerCase();
  }

  /**
   * Check if two time periods overlap
   * Periods overlap if: startTime1 < endTime2 AND endTime1 > startTime2
   */
  private doPeriodsOverlap(start1: string, end1: string, start2: string, end2: string): boolean {
    // Times are in HH:mm format, so string comparison works for lexicographic ordering
    return start1 < end2 && end1 > start2;
  }

  /**
   * Get all timetables for a school type (grouped by class)
   */
  async getTimetablesForSchoolType(
    schoolId: string,
    schoolType?: 'PRIMARY' | 'SECONDARY' | 'TERTIARY',
    termId?: string
  ): Promise<Record<string, TimetablePeriodDto[]>> {
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    // Build where clause that handles both Class and ClassArm periods
    const orConditions: any[] = [];

    // Condition for periods linked to Class records
    const classCondition: any = {
      class: {
        schoolId: school.id,
        ...(schoolType ? { type: schoolType } : {}),
      },
    };
    orConditions.push(classCondition);

    // Condition for periods linked to ClassArm records (for PRIMARY/SECONDARY)
    if (!schoolType || schoolType === 'PRIMARY' || schoolType === 'SECONDARY') {
      const classArmCondition: any = {
        classArm: {
          classLevel: {
            schoolId: school.id,
            ...(schoolType ? { type: schoolType } : {}),
          },
        },
      };
      orConditions.push(classArmCondition);
    }

    const where: any = {
      OR: orConditions,
    };

    if (termId) {
      where.termId = termId;
    }

    const periods = await this.timetablePeriodModel.findMany({
      where,
      include: {
        subject: true,
        course: true,
        class: true,
        teacher: true,
        room: true,
        classArm: {
          include: {
            classLevel: true,
          },
        },
        term: true,
      },
      orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
    });

    // Group periods by class or classArm
    const timetablesByClass: Record<string, TimetablePeriodDto[]> = {};
    periods.forEach((period: any) => {
      // Use classArmId for ClassArm periods, classId for Class periods
      const groupId = period.classArmId || period.classId;
      if (groupId) {
        if (!timetablesByClass[groupId]) {
          timetablesByClass[groupId] = [];
        }
        timetablesByClass[groupId].push(this.mapToPeriodDto(period));
      }
    });

    return timetablesByClass;
  }

  /**
   * Update a timetable period
   */
  async updatePeriod(
    schoolId: string,
    periodId: string,
    dto: Partial<CreateTimetablePeriodDto>
  ): Promise<TimetablePeriodDto> {
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    const period = await this.timetablePeriodModel.findUnique({
      where: { id: periodId },
      include: {
        term: {
          include: {
            academicSession: true,
          },
        },
      },
    });

    if (!period || period.term.academicSession.schoolId !== school.id) {
      throw new NotFoundException('Timetable period not found');
    }

    // Check for conflicts if teacher or room is being updated
    if (dto.teacherId || dto.roomId) {
      const conflict = await this.detectConflicts(
        {
          ...period,
          ...dto,
          dayOfWeek: dto.dayOfWeek || period.dayOfWeek,
          startTime: dto.startTime || period.startTime,
          endTime: dto.endTime || period.endTime,
          classArmId: dto.classArmId || period.classArmId,
          termId: dto.termId || period.termId,
        } as CreateTimetablePeriodDto,
        school.id,
        periodId
      );

      if (conflict) {
        throw new ConflictException(conflict.message);
      }
    }

    // Check for same-class time overlaps when start or end time is being changed
    if (dto.startTime !== undefined || dto.endTime !== undefined) {
      const effectiveClassArmIdForOverlap = dto.classArmId ?? period.classArmId;
      const effectiveClassIdForOverlap = dto.classId ?? period.classId;
      const effectiveDay = dto.dayOfWeek ?? period.dayOfWeek;
      const effectiveTerm = dto.termId ?? period.termId;
      const effectiveStart = dto.startTime ?? period.startTime;
      const effectiveEnd = dto.endTime ?? period.endTime;

      // Build query to find other periods in the same class/arm + day + term
      const sameClassWhere: any = {
        id: { not: periodId },
        dayOfWeek: effectiveDay,
        termId: effectiveTerm,
      };

      if (effectiveClassArmIdForOverlap) {
        sameClassWhere.classArmId = effectiveClassArmIdForOverlap;
      } else if (effectiveClassIdForOverlap) {
        sameClassWhere.classId = effectiveClassIdForOverlap;
      }

      const sameDayPeriods = await this.timetablePeriodModel.findMany({
        where: sameClassWhere,
      });

      const overlappingPeriod = sameDayPeriods.find((p: any) =>
        this.doPeriodsOverlap(effectiveStart, effectiveEnd, p.startTime, p.endTime)
      );

      if (overlappingPeriod) {
        throw new ConflictException(
          `Time slot ${effectiveStart}–${effectiveEnd} on ${effectiveDay} overlaps with an existing period (${overlappingPeriod.startTime}–${overlappingPeriod.endTime})`
        );
      }
    }

    // Build update data object, only including fields that are provided
    const updateData: any = {};
    if (dto.dayOfWeek !== undefined) updateData.dayOfWeek = dto.dayOfWeek;
    if (dto.startTime !== undefined) updateData.startTime = dto.startTime;
    if (dto.endTime !== undefined) updateData.endTime = dto.endTime;
    if (dto.type !== undefined) updateData.type = dto.type;
    if (dto.subjectId !== undefined) updateData.subjectId = dto.subjectId;
    if (dto.courseId !== undefined) updateData.courseId = dto.courseId;
    if (dto.classId !== undefined) updateData.classId = dto.classId;
    if (dto.teacherId !== undefined) updateData.teacherId = dto.teacherId;
    if (dto.roomId !== undefined) updateData.roomId = dto.roomId;
    if (dto.classArmId !== undefined) updateData.classArmId = dto.classArmId;

    // Validate time format if times are being updated
    if (updateData.startTime) {
      this.validateTimeFormat(updateData.startTime);
    }
    if (updateData.endTime) {
      this.validateTimeFormat(updateData.endTime);
    }

    // Validate time range if both times are provided
    if (updateData.startTime && updateData.endTime) {
      if (updateData.startTime >= updateData.endTime) {
        throw new BadRequestException('Start time must be before end time');
      }
    } else if (updateData.startTime && period.endTime) {
      if (updateData.startTime >= period.endTime) {
        throw new BadRequestException('Start time must be before end time');
      }
    } else if (updateData.endTime && period.startTime) {
      if (period.startTime >= updateData.endTime) {
        throw new BadRequestException('Start time must be before end time');
      }
    }

    // REQ-P3: For PRIMARY LESSON periods with no teacher, auto-fill the class teacher
    const effectiveClassArmId = updateData.classArmId ?? period.classArmId;
    const effectiveType = updateData.type ?? period.type;
    const effectiveTeacherId = updateData.teacherId ?? period.teacherId;

    if (effectiveClassArmId && !effectiveTeacherId && effectiveType === PeriodType.LESSON) {
      const arm = await this.prisma.classArm.findUnique({
        where: { id: effectiveClassArmId },
        include: { classLevel: true },
      });
      if (arm?.classLevel.type === 'PRIMARY') {
        const primaryTeacherId = await this.resolvePrimaryTeacher(effectiveClassArmId);
        if (primaryTeacherId) {
          updateData.teacherId = primaryTeacherId;
        }
      }
    }

    const updated = await this.timetablePeriodModel.update({
      where: { id: periodId },
      data: updateData,
      include: {
        subject: true,
        course: true,
        class: true,
        teacher: true,
        room: true,
        classArm: {
          include: {
            classLevel: true,
          },
        },
      },
    });

    const updatedDto = this.mapToPeriodDto(updated);

    // REQ-2 + REQ-3: Sync ClassTeacher when teacher is explicitly set on an update
    const warnings: string[] = [];
    if (
      updated.subjectId &&
      updated.classArmId &&
      updated.teacherId &&
      updated.type === 'LESSON'
    ) {
      warnings.push(...(await this.syncClassTeacherFromPeriod(updated)));
    }

    if (warnings.length > 0) {
      (updatedDto as any).warnings = warnings;
    }

    return updatedDto;
  }

  /**
   * Delete a timetable period
   */
  async deletePeriod(schoolId: string, periodId: string): Promise<void> {
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    const period = await this.timetablePeriodModel.findUnique({
      where: { id: periodId },
      include: {
        term: {
          include: {
            academicSession: true,
          },
        },
      },
    });

    if (!period || period.term.academicSession.schoolId !== school.id) {
      throw new NotFoundException('Timetable period not found');
    }

    await this.timetablePeriodModel.delete({
      where: { id: periodId },
    });
  }

  /**
   * Delete all timetable periods for a class and term (delete entire timetable)
   */
  async deleteTimetableForClass(schoolId: string, classId: string, termId: string): Promise<void> {
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    // Check if this is a ClassArm ID first
    const classArm = await this.prisma.classArm.findUnique({
      where: { id: classId },
      include: { classLevel: true },
    });

    let isClassArm = false;

    if (classArm) {
      // Validate ClassArm belongs to school
      if (classArm.classLevel.schoolId !== school.id) {
        throw new NotFoundException('Class not found');
      }
      isClassArm = true;
    } else {
      // Check if it's a Class ID
      const classData = await this.prisma.class.findUnique({
        where: { id: classId },
      });

      if (!classData || classData.schoolId !== school.id) {
        throw new NotFoundException('Class not found');
      }
    }

    // Validate term exists and belongs to school
    const term = await this.prisma.term.findUnique({
      where: { id: termId },
      include: {
        academicSession: true,
      },
    });

    if (!term || term.academicSession.schoolId !== school.id) {
      throw new NotFoundException('Term not found');
    }

    // Delete all periods for this class/classArm and term
    if (isClassArm) {
      await this.timetablePeriodModel.deleteMany({
        where: {
          classArmId: classId,
          termId: termId,
        },
      });
    } else {
      await this.timetablePeriodModel.deleteMany({
        where: {
          classId: classId,
          termId: termId,
        },
      });
    }
  }

  /**
   * Replace the entire timetable for a class/classArm+term atomically.
   *
   * Executes in a single Prisma transaction:
   *   1. Delete all existing periods for this class/arm + term
   *   2. Insert all new periods from the payload
   *
   * This replaces the N-request waterfall from the frontend edit table with
   * a single round-trip, eliminating partial-save failures and race conditions.
   *
   * Teacher/room conflict detection is intentionally NOT re-run here because:
   *   - The frontend already validates overlaps before calling this endpoint
   *   - The payload represents the admin's final intended state
   *   - Re-running per-period conflict detection in a transaction would require
   *     intermediate state awareness that Prisma doesn't support cleanly
   */
  async replaceTimetable(
    schoolId: string,
    dto: ReplaceTimetableDto
  ): Promise<{ replaced: number }> {
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    // Validate term
    const term = await this.prisma.term.findUnique({
      where: { id: dto.termId },
      include: { academicSession: true },
    });
    if (!term || term.academicSession.schoolId !== school.id) {
      throw new NotFoundException('Term not found');
    }

    // Validate class or classArm ownership
    if (!dto.classId && !dto.classArmId) {
      throw new BadRequestException('Either classId or classArmId must be provided');
    }
    if (dto.classId) {
      const classData = await this.prisma.class.findUnique({ where: { id: dto.classId } });
      if (!classData || classData.schoolId !== school.id) {
        throw new NotFoundException('Class not found');
      }
    }
    if (dto.classArmId) {
      const classArm = await this.prisma.classArm.findUnique({
        where: { id: dto.classArmId },
        include: { classLevel: true },
      });
      if (!classArm || classArm.classLevel.schoolId !== school.id) {
        throw new NotFoundException('Class arm not found');
      }
    }

    // Validate all period times upfront (before the transaction)
    const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
    for (const p of dto.periods) {
      if (!TIME_RE.test(p.startTime)) {
        throw new BadRequestException(`Invalid startTime format: ${p.startTime}`);
      }
      if (!TIME_RE.test(p.endTime)) {
        throw new BadRequestException(`Invalid endTime format: ${p.endTime}`);
      }
      if (p.startTime >= p.endTime) {
        throw new BadRequestException(
          `Period ${p.startTime}–${p.endTime}: start must be before end`
        );
      }
    }

    // Atomic: delete existing + bulk-insert new
    const periodsToCreate = dto.periods.map((p) => ({
      dayOfWeek: p.dayOfWeek,
      startTime: p.startTime,
      endTime: p.endTime,
      type: p.type || PeriodType.LESSON,
      subjectId: p.subjectId || null,
      courseId: p.courseId || null,
      teacherId: p.teacherId || null,
      roomId: p.roomId || null,
      classId: dto.classId || p.classId || null,
      classArmId: dto.classArmId || p.classArmId || null,
      termId: dto.termId,
    }));

    const whereClause: any = { termId: dto.termId };
    if (dto.classArmId) {
      whereClause.classArmId = dto.classArmId;
    } else {
      whereClause.classId = dto.classId;
    }

    const [, createResult] = await this.prisma.$transaction([
      (this.prisma as any).timetablePeriod.deleteMany({ where: whereClause }),
      (this.prisma as any).timetablePeriod.createMany({
        data: periodsToCreate,
        skipDuplicates: false,
      }),
    ]);

    return { replaced: createResult.count };
  }

  /**
   * Detect conflicts for teacher and room
   * Time overlap: periods overlap if startTime < other.endTime AND endTime > other.startTime
   * Since times are in HH:mm format, string comparison works for lexicographic ordering
   */
  private async detectConflicts(
    dto: CreateTimetablePeriodDto,
    schoolId: string,
    excludePeriodId?: string
  ): Promise<ConflictInfo | null> {
    // Only check conflicts for LESSON periods with teacher/room assigned
    if (dto.type !== PeriodType.LESSON || (!dto.teacherId && !dto.roomId)) {
      return null;
    }

    // Build where clause for conflict detection
    const where: any = {
      termId: dto.termId,
      dayOfWeek: dto.dayOfWeek,
      type: PeriodType.LESSON,
      ...(excludePeriodId && { id: { not: excludePeriodId } }),
    };

    // If classId is provided, check conflicts for that class
    // If classArmId is provided, check conflicts for that class arm
    if (dto.classId) {
      where.classId = dto.classId;
    } else if (dto.classArmId) {
      where.classArmId = dto.classArmId;
    }

    // Get all periods for the same day and term
    const allPeriods = await this.timetablePeriodModel.findMany({
      where,
      include: {
        class: true,
        classArm: {
          include: {
            classLevel: true,
          },
        },
        teacher: true,
        room: true,
      },
    });

    // Filter for overlapping time periods
    const overlappingPeriods = allPeriods.filter((period: any) => {
      // Periods overlap if: startTime < dto.endTime AND endTime > dto.startTime
      return period.startTime < dto.endTime && period.endTime > dto.startTime;
    });

    // Check teacher conflict
    if (dto.teacherId) {
      const teacherConflict = overlappingPeriods.find((p: any) => p.teacherId === dto.teacherId);

      if (teacherConflict) {
        const teacherName = teacherConflict.teacher
          ? `${teacherConflict.teacher.firstName} ${teacherConflict.teacher.lastName}`
          : 'Unknown';
        const classArmName = teacherConflict.classArm
          ? `${teacherConflict.classArm.classLevel.name} ${teacherConflict.classArm.name}`
          : 'Unknown';

        return {
          type: 'TEACHER',
          message: `${teacherName} is already teaching ${classArmName} at ${teacherConflict.startTime} on ${dto.dayOfWeek}`,
          conflictingPeriodId: teacherConflict.id,
        };
      }
    }

    // Check room conflict
    if (dto.roomId) {
      const roomConflict = overlappingPeriods.find((p: any) => p.roomId === dto.roomId);

      if (roomConflict) {
        const roomName = roomConflict.room?.name || 'Unknown';
        const classArmName = roomConflict.classArm
          ? `${roomConflict.classArm.classLevel.name} ${roomConflict.classArm.name}`
          : roomConflict.class
            ? roomConflict.class.name
            : 'Unknown';

        return {
          type: 'ROOM',
          message: `${roomName} is already occupied by ${classArmName} at ${roomConflict.startTime} on ${dto.dayOfWeek}`,
          conflictingPeriodId: roomConflict.id,
        };
      }
    }

    return null;
  }

  /**
   * Validate time format (HH:mm)
   */
  private validateTimeFormat(time: string): void {
    const timeRegex = /^([0-1][0-9]|2[0-3]):[0-5][0-9]$/;
    if (!timeRegex.test(time)) {
      throw new BadRequestException(
        `Invalid time format: ${time}. Expected HH:mm format (e.g., "08:00")`
      );
    }
  }

  /**
   * Automatically delete timetables older than 1 year
   * Runs daily at midnight
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleAutoDeletion() {
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

    const deleted = await this.timetablePeriodModel.deleteMany({
      where: {
        createdAt: {
          lt: oneYearAgo,
        },
      },
    });

    if (deleted.count > 0) {
      console.log(`[TimetableService] Auto-deleted ${deleted.count} timetable periods older than 1 year.`);
    }
  }

  /**
   * Map Prisma period to DTO
   */
  /**
   * Get current activities for multiple entities (staff or students)
   */

  private mapToPeriodDto(period: any): TimetablePeriodDto {
    const dto: TimetablePeriodDto = {
      id: period.id,
      dayOfWeek: period.dayOfWeek,
      startTime: period.startTime,
      endTime: period.endTime,
      type: period.type,
      subjectId: period.subjectId,
      subjectName: period.subject?.name,
      courseId: period.courseId,
      courseName: period.course?.name,
      teacherId: period.teacherId,
      teacherName: period.teacher
        ? `${period.teacher.firstName} ${period.teacher.lastName}`
        : undefined,
      // Include full teacher details for secondary school class detail pages
      teacher: period.teacher
        ? {
          id: period.teacher.id,
          firstName: period.teacher.firstName,
          lastName: period.teacher.lastName,
          email: period.teacher.email || '',
          phone: period.teacher.phone || '',
          profileImage: period.teacher.profileImage || null,
        }
        : undefined,
      roomId: period.roomId,
      roomName: period.room?.name,
      classArmId: period.classArmId,
      classArmName: period.classArm
        ? `${period.classArm.classLevel.name} ${period.classArm.name}`
        : '',
      termId: period.termId,
      createdAt: period.createdAt,
    };

    // Add optional fields if they exist
    if (period.hasConflict !== undefined) {
      (dto as any).hasConflict = period.hasConflict;
    }
    if (period.conflictMessage) {
      (dto as any).conflictMessage = period.conflictMessage;
    }
    if (period.conflictingPeriodIds) {
      (dto as any).conflictingPeriodIds = period.conflictingPeriodIds;
    }
    if (period.isFromCourseRegistration !== undefined) {
      (dto as any).isFromCourseRegistration = period.isFromCourseRegistration;
    }

    return dto;
  }

  private async notifyTimetableChange(
    schoolId: string,
    opts: { classId?: string | null; classArmId?: string | null; teacherId?: string | null },
  ) {
    try {
      const studentIds = await this.notificationInbox.getStudentUserIdsInClass({
        schoolId,
        classId: opts.classId || undefined,
        classArmId: opts.classArmId || undefined,
      });
      const teacherUserIds = new Set<string>(
        await this.notificationInbox.getTeacherUserIdsForClass({
          schoolId,
          classId: opts.classId || undefined,
          classArmId: opts.classArmId || undefined,
        }),
      );
      if (opts.teacherId) {
        const uid = await this.notificationInbox.getTeacherUserId(opts.teacherId);
        if (uid) teacherUserIds.add(uid);
      }

      let className = 'Your class';
      if (opts.classArmId) {
        const arm = await this.prisma.classArm.findUnique({
          where: { id: opts.classArmId },
          select: { name: true, classLevel: { select: { name: true } } },
        });
        if (arm) className = [arm.classLevel?.name, arm.name].filter(Boolean).join(' ');
      } else if (opts.classId) {
        const cls = await this.prisma.class.findUnique({
          where: { id: opts.classId },
          select: { name: true },
        });
        if (cls?.name) className = cls.name;
      }
      const title = 'Timetable changed';
      const subtitle = className;
      const body = `A lesson was added or changed on the ${className} timetable.`;
      await this.notificationInbox.createAndFanOut([
        ...[...teacherUserIds].map((userId) => ({
          userId,
          schoolId,
          role: 'TEACHER',
          type: 'TIMETABLE_UPDATED',
          title,
          subtitle,
          body,
          link: '/dashboard/teacher/timetables',
        })),
        ...studentIds.map((userId) => ({
          userId,
          schoolId,
          role: 'STUDENT',
          type: 'TIMETABLE_UPDATED',
          title,
          subtitle,
          body,
          link: '/dashboard/student/timetables',
        })),
      ]);
    } catch (err: any) {
      this.logger.warn(`Timetable notify failed: ${err?.message || err}`);
    }
  }
}
