import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { StudentDto, StudentWithEnrollmentDto } from './dto/student.dto';
import { PaginationDto, PaginatedResponseDto } from '../common/dto/pagination.dto';
import { ClassType } from '../schools/dto/create-class.dto';
import { UserWithContext } from '../auth/types/user-with-context.type';
import { LiveStatusService } from '../live-status/live-status.service';
import { TimetableService } from '../timetable/timetable.service';
import { ExamTimetableService } from '../exam-timetable/exam-timetable.service';
import { GradesService } from '../grades/grades.service';
import { EventService } from '../events/event.service';
import { CloudinaryService } from '../storage/cloudinary/cloudinary.service';
import { safeResolvePath } from '../common/utils/path-traversal';
import { NotificationService } from '../notification/notification.service';

import { ReassignStudentDto } from './dto/reassign-student.dto';
import { hasPrincipalAccess } from '../schools/dto/permission.dto';
import { SchoolSettingsService } from '../school-settings/school-settings.service';

@Injectable()
export class StudentsService {
  private readonly logger = new Logger(StudentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly timetableService: TimetableService,
    private readonly examTimetableService: ExamTimetableService,
    private readonly liveStatusService: LiveStatusService,
    private readonly gradesService: GradesService,
    private readonly eventService: EventService,
    private readonly cloudinaryService: CloudinaryService,
    private readonly notificationService: NotificationService,
    private readonly schoolSettingsService: SchoolSettingsService,
  ) { }

  async findAll(
    tenantId: string,
    pagination: PaginationDto,
    schoolType?: ClassType | string,
    search?: string,
    status?: 'active' | 'pending' | 'suspended',
  ): Promise<PaginatedResponseDto<StudentWithEnrollmentDto>> {
    const { page = 1, limit = 20 } = pagination;
    const skip = (page - 1) * limit;

    // If schoolType is provided, get classes AND classArms of that type to filter enrollments
    let classIds: string[] = [];
    let classLevels: string[] = [];
    const classArmIds: string[] = [];

    if (schoolType) {
      // Get Class records of this type (for backward compatibility and TERTIARY)
      const classes = await this.prisma.class.findMany({
        where: {
          schoolId: tenantId,
          type: schoolType,
          isActive: true,
        },
        select: {
          id: true,
          name: true,
        },
      });
      classIds = classes.map((c) => c.id);
      classLevels = classes.map((c) => c.name);

      // Also get ClassLevel + ClassArm records for PRIMARY/SECONDARY (new system)
      if (schoolType === 'PRIMARY' || schoolType === 'SECONDARY') {
        const classLevelRecords = await this.prisma.classLevel.findMany({
          where: {
            schoolId: tenantId,
            type: schoolType,
            isActive: true,
          },
          include: {
            classArms: {
              where: { isActive: true },
              select: { id: true, name: true },
            },
          },
        });

        // Add ClassLevel names and ClassArm IDs
        for (const cl of classLevelRecords) {
          classLevels.push(cl.name);
          for (const arm of cl.classArms) {
            classArmIds.push(arm.id);
            // Also add full arm name (e.g., "Primary 1 Gold") to classLevels
            classLevels.push(`${cl.name} ${arm.name}`);
          }
        }
      }

      // Remove duplicates
      classLevels = [...new Set(classLevels)];
    }

    // Build the enrollment filter
    const enrollmentFilter: any = {
      schoolId: tenantId,
      isActive: true,
    };

    // If schoolType is provided, we MUST filter by it
    if (schoolType) {
      // If no classes/classArms found for this school type, return empty result
      if (classIds.length === 0 && classLevels.length === 0 && classArmIds.length === 0) {
        const emptyResponse = new PaginatedResponseDto<StudentWithEnrollmentDto>();
        emptyResponse.data = [];
        emptyResponse.total = 0;
        emptyResponse.page = page;
        emptyResponse.limit = limit;
        emptyResponse.totalPages = 0;
        emptyResponse.hasNext = false;
        emptyResponse.hasPrev = false;
        emptyResponse.statusCounts = { active: 0, pending: 0, suspended: 0, archived: 0 };
        return emptyResponse;
      }

      // Add the type filter
      enrollmentFilter.OR = [
        ...(classIds.length > 0 ? [{ classId: { in: classIds } }] : []),
        ...(classArmIds.length > 0 ? [{ classArmId: { in: classArmIds } }] : []),
        ...(classLevels.length > 0 ? [{ classLevel: { in: classLevels } }] : []),
      ];
    }

    const whereClause: any = {
      enrollments: {
        some: enrollmentFilter,
      },
    };

    const trimmedSearch = search?.trim();
    if (trimmedSearch) {
      whereClause.OR = [
        { firstName: { contains: trimmedSearch, mode: 'insensitive' } },
        { lastName: { contains: trimmedSearch, mode: 'insensitive' } },
        { middleName: { contains: trimmedSearch, mode: 'insensitive' } },
        { uid: { contains: trimmedSearch, mode: 'insensitive' } },
        { publicId: { contains: trimmedSearch, mode: 'insensitive' } },
      ];
    }

    const statusWhere = (accountStatus: 'ACTIVE' | 'SHADOW' | 'SUSPENDED' | 'ARCHIVED') => ({
      ...whereClause,
      user: { accountStatus },
    });

    const accountStatusFilter = {
      active: 'ACTIVE',
      pending: 'SHADOW',
      suspended: 'SUSPENDED',
    } as const;
    const selectedStatus = status ? accountStatusFilter[status] : undefined;
    const listWhere = selectedStatus
      ? { ...whereClause, user: { accountStatus: selectedStatus } }
      : whereClause;

    const [students, total, active, pending, suspended, archived] = await Promise.all([
      this.prisma.student.findMany({
        where: listWhere,
        include: {
          user: {
            select: {
              id: true,
              email: true,
              phone: true,
              accountStatus: true,
            },
          },
          enrollments: {
            where: enrollmentFilter,
            include: {
              school: {
                select: {
                  id: true,
                  name: true,
                  
                },
              },
            },
            take: 1,
            orderBy: { enrollmentDate: 'desc' },
          },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.student.count({
        where: listWhere,
      }),
      this.prisma.student.count({ where: statusWhere('ACTIVE') }),
      this.prisma.student.count({ where: statusWhere('SHADOW') }),
      this.prisma.student.count({ where: statusWhere('SUSPENDED') }),
      this.prisma.student.count({ where: statusWhere('ARCHIVED') }),
    ]);

    const studentIds = students.map(s => s.id);
    const liveActivities = await this.liveStatusService.getCurrentActivities(
      tenantId,
      studentIds,
      'STUDENT'
    );

    const data = students.map((student) => ({
      ...this.toDto(student),
      enrollment: student.enrollments[0]
        ? {
          id: student.enrollments[0].id,
          classLevel: student.enrollments[0].classLevel,
          academicYear: student.enrollments[0].academicYear,
          enrollmentDate: student.enrollments[0].enrollmentDate.toISOString(),
          school: student.enrollments[0].school,
        }
        : undefined,
      currentActivity: liveActivities[student.id] || null,
    }));

    const response = new PaginatedResponseDto<StudentWithEnrollmentDto>();
    response.data = data;
    response.total = total;
    response.page = page;
    response.limit = limit;
    response.totalPages = Math.ceil(total / limit);
    response.hasNext = page < response.totalPages;
    response.hasPrev = page > 1;
    response.statusCounts = { active, pending, suspended, archived };
    return response;
  }

  async findOne(tenantId: string, id: string): Promise<StudentWithEnrollmentDto> {
    const student = await this.prisma.student.findFirst({
      where: {
        id,
        enrollments: {
          some: {
            schoolId: tenantId,
            isActive: true,
          },
        },
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            phone: true,
            accountStatus: true,
          },
        },
        enrollments: {
          where: {
            schoolId: tenantId,
            isActive: true,
          },
          include: {
            school: {
              select: {
                id: true,
                name: true,
                
              },
            },
          },
          take: 1,
          orderBy: { enrollmentDate: 'desc' },
        },
      },
    });

    if (!student) {
      throw new NotFoundException(`Student with ID ${id} not found`);
    }

    const liveActivities = await this.liveStatusService.getCurrentActivities(
      tenantId,
      [student.id],
      'STUDENT'
    );

    return {
      ...this.toDto(student),
      enrollment: student.enrollments[0]
        ? {
          id: student.enrollments[0].id,
          classLevel: student.enrollments[0].classLevel,
          academicYear: student.enrollments[0].academicYear,
          enrollmentDate: student.enrollments[0].enrollmentDate.toISOString(),
          school: student.enrollments[0].school,
        }
        : undefined,
      currentActivity: liveActivities[student.id] || null,
    };
  }

  async findByUid(tenantId: string, uid: string): Promise<StudentWithEnrollmentDto> {
    const student = await this.prisma.student.findUnique({
      where: { uid },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            phone: true,
            accountStatus: true,
          },
        },
        enrollments: {
          where: {
            schoolId: tenantId,
            isActive: true,
          },
          include: {
            school: {
              select: {
                id: true,
                name: true,
                
              },
            },
          },
          take: 1,
          orderBy: { enrollmentDate: 'desc' },
        },
      },
    });

    if (!student) {
      throw new NotFoundException(`Student with UID ${uid} not found`);
    }

    // Verify student is enrolled in the tenant's school
    if (student.enrollments.length === 0) {
      throw new NotFoundException(`Student with UID ${uid} not found in this school`);
    }

    const liveActivities = await this.liveStatusService.getCurrentActivities(
      tenantId,
      [student.id],
      'STUDENT'
    );

    return {
      ...this.toDto(student),
      enrollment: {
        id: student.enrollments[0].id,
        classLevel: student.enrollments[0].classLevel,
        academicYear: student.enrollments[0].academicYear,
        enrollmentDate: student.enrollments[0].enrollmentDate.toISOString(),
        school: student.enrollments[0].school,
      },
      currentActivity: liveActivities[student.id] || null,
    };
  }

  async findByClassLevel(
    tenantId: string,
    classLevel: string
  ): Promise<StudentWithEnrollmentDto[]> {
    const students = await this.prisma.student.findMany({
      where: {
        enrollments: {
          some: {
            schoolId: tenantId,
            classLevel: classLevel,
            isActive: true,
          },
        },
      },
      include: {
        enrollments: {
          where: {
            schoolId: tenantId,
            classLevel: classLevel,
            isActive: true,
          },
          include: {
            school: {
              select: {
                id: true,
                name: true,
                
              },
            },
          },
          take: 1,
          orderBy: { enrollmentDate: 'desc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return students.map((student) => ({
      ...this.toDto(student),
      enrollment: student.enrollments[0]
        ? {
          id: student.enrollments[0].id,
          classLevel: student.enrollments[0].classLevel,
          academicYear: student.enrollments[0].academicYear,
          enrollmentDate: student.enrollments[0].enrollmentDate.toISOString(),
          school: student.enrollments[0].school,
        }
        : undefined,
    }));
  }

  private toDto(student: any): StudentDto {
    // Parse healthInfo from JSON if it exists
    let healthInfo: any = null;
    if (student.healthInfo) {
      if (typeof student.healthInfo === 'string') {
        try {
          healthInfo = JSON.parse(student.healthInfo);
        } catch {
          healthInfo = null;
        }
      } else {
        healthInfo = student.healthInfo;
      }
    }

    return {
      id: student.id,
      uid: student.uid,
      firstName: student.firstName,
      lastName: student.lastName,
      middleName: student.middleName,
      dateOfBirth: student.dateOfBirth.toISOString().split('T')[0],
      profileLocked: student.profileLocked,
      profileImage: student.profileImage,
      nationality: student.nationality ?? undefined,
      state: student.state ?? undefined,
      healthInfo: healthInfo,
      createdAt: student.createdAt.toISOString(),
      updatedAt: student.updatedAt.toISOString(),
      user: student.user
        ? {
          id: student.user.id,
          email: student.user.email,
          phone: student.user.phone,
          accountStatus: student.user.accountStatus,
        }
        : undefined,
    };
  }

  /**
   * Get current student profile
   */
  async getMyProfile(user: UserWithContext): Promise<any> {
    if (user.role !== 'STUDENT') {
      throw new ForbiddenException('Access denied. Student role required.');
    }

    // Find student by userId
    const student = await this.prisma.student.findFirst({
      where: {
        userId: user.id,
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            phone: true,
            accountStatus: true,
          },
        },
        enrollments: {
          where: {
            isActive: true,
            // If currentSchoolId is set, filter by it; otherwise get all active enrollments
            ...(user.currentSchoolId ? { schoolId: user.currentSchoolId } : {}),
          },
          include: {
            school: {
              select: {
                id: true,
                name: true,
                
                hasPrimary: true,
                hasSecondary: true,
                hasTertiary: true,
              },
            },
            class: {
              select: {
                id: true,
                name: true,
                type: true,
              },
            },
          },
          orderBy: { enrollmentDate: 'desc' },
        },
      },
    });

    if (!student) {
      throw new NotFoundException('Student profile not found');
    }

    // If no active enrollments, return profile without enrollments
    if (student.enrollments.length === 0) {
      return {
        ...this.toDto(student),
        enrollments: [],
        school: null,
      };
    }

    // Get the most recent active enrollment's school as the current school
    const currentEnrollment = student.enrollments[0];
    const currentSchool = currentEnrollment.school;

    return {
      ...this.toDto(student),
      enrollments: student.enrollments.map((e) => ({
        id: e.id,
        classLevel: e.classLevel,
        academicYear: e.academicYear,
        enrollmentDate: e.enrollmentDate.toISOString(),
        school: e.school,
        class: e.class,
      })),
      school: currentSchool, // Include current school for compatibility
    };
  }

  /**
   * Get all enrollments for current student
   */
  async getMyEnrollments(user: UserWithContext): Promise<any[]> {
    if (user.role !== 'STUDENT') {
      throw new ForbiddenException('Access denied. Student role required.');
    }

    const student = await this.prisma.student.findFirst({
      where: {
        userId: user.id,
      },
      include: {
        enrollments: {
          include: {
            school: {
              select: {
                id: true,
                name: true,
                isActive: true,
                lifecycleStatus: true,
                deactivationReason: true,
              },
            },
            class: {
              select: {
                id: true,
                name: true,
                type: true,
              },
            },
          },
          orderBy: { enrollmentDate: 'desc' },
        },
      },
    });

    if (!student) {
      throw new NotFoundException('Student profile not found');
    }

    return student.enrollments.map((e) => ({
      id: e.id,
      classLevel: e.classLevel,
      academicYear: e.academicYear,
      enrollmentDate: e.enrollmentDate.toISOString(),
      isActive: e.isActive,
      school: e.school,
      class: e.class,
    }));
  }

  /**
   * Get timetable for current student
   */
  async getMyTimetable(
    user: UserWithContext,
    schoolId: string | null,
    termId?: string
  ): Promise<any[]> {
    if (user.role !== 'STUDENT') {
      throw new ForbiddenException('Access denied. Student role required.');
    }

    // Get student's active enrollments
    // If schoolId is provided, use it; otherwise get from active enrollments
    const studentWhere: any = {
      userId: user.id,
    };

    if (schoolId) {
      studentWhere.enrollments = {
        some: {
          schoolId,
          isActive: true,
        },
      };
    } else {
      studentWhere.enrollments = {
        some: {
          isActive: true,
        },
      };
    }

    const student = await this.prisma.student.findFirst({
      where: studentWhere,
      include: {
        enrollments: {
          where: {
            ...(schoolId ? { schoolId } : {}),
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
        },
      },
    });

    if (!student || student.enrollments.length === 0) {
      return [];
    }

    // Get schoolId from enrollments if not provided
    const actualSchoolId = schoolId || student.enrollments[0]?.schoolId;
    if (!actualSchoolId) {
      return [];
    }

    // Derive schoolType from student's enrollment for correct session lookup
    const enrollment = student.enrollments[0];
    let schoolType: string | null = null;

    // Check classArm's classLevel type first (for ClassArm-based enrollments)
    if (enrollment.classArm?.classLevel?.type) {
      schoolType = enrollment.classArm.classLevel.type;
    }
    // Fallback to class type
    else if (enrollment.class?.type) {
      schoolType = enrollment.class.type;
    }

    // Always find the correct active term for this student's schoolType
    // This ensures we use the right term even if frontend passes wrong termId
    let activeTermId = termId;

    // Find active session for this student's schoolType
    const activeSession = await this.prisma.academicSession.findFirst({
      where: {
        schoolId: actualSchoolId,
        status: 'ACTIVE',
        ...(schoolType ? { schoolType } : {}),
      },
      include: {
        terms: {
          where: {
            status: 'ACTIVE',
          },
          orderBy: { startDate: 'desc' },
          take: 1,
        },
      },
    });

    // If we found an active session for this schoolType, use its term
    if (activeSession && activeSession.terms.length > 0) {
      activeTermId = activeSession.terms[0].id;
    } else if (!activeTermId) {
      // Only fallback if no termId was provided AND no session found
      const fallbackSession = await this.prisma.academicSession.findFirst({
        where: {
          schoolId: actualSchoolId,
          status: 'ACTIVE',
        },
        include: {
          terms: {
            where: {
              status: 'ACTIVE',
            },
            orderBy: { startDate: 'desc' },
            take: 1,
          },
        },
      });
      if (fallbackSession && fallbackSession.terms.length > 0) {
        activeTermId = fallbackSession.terms[0].id;
      } else {
        return [];
      }
    }

    // If still no termId, return empty
    if (!activeTermId) {
      return [];
    }

    // Use TimetableService.getTimetableForStudent which handles:
    // - PRIMARY/SECONDARY: Returns timetable for student's class (existing logic)
    // - TERTIARY: Merges home class timetable + course registration subjects with conflict detection
    try {
      return await this.timetableService.getTimetableForStudent(
        actualSchoolId,
        student.id,
        activeTermId
      );
    } catch (error) {
      // If error, return empty array (e.g., student not found, etc.)
      return [];
    }
  }

  /** Published exam timetable slots for the student's class during exam period. */
  async getMyExamTimetable(
    user: UserWithContext,
    schoolId: string | null,
    termId?: string,
  ) {
    if (user.role !== 'STUDENT') {
      throw new ForbiddenException('Access denied. Student role required.');
    }
    const student = await this.prisma.student.findFirst({ where: { userId: user.id } });
    if (!student) return [];

    let actualSchoolId = schoolId;
    if (!actualSchoolId) {
      const enrollment = await this.prisma.enrollment.findFirst({
        where: { studentId: student.id, isActive: true },
        select: { schoolId: true },
      });
      actualSchoolId = enrollment?.schoolId ?? null;
    }
    if (!actualSchoolId) return [];

    return this.examTimetableService.listSlotsForStudent(
      actualSchoolId,
      student.id,
      termId,
    );
  }

  /**
   * Get published grades for current student
   */
  async getMyGrades(
    user: UserWithContext,
    schoolId: string | null,
    filters?: { classId?: string; termId?: string; subject?: string }
  ): Promise<any[]> {
    if (user.role !== 'STUDENT') {
      throw new ForbiddenException('Access denied. Student role required.');
    }

    // Get student by userId
    const student = await this.prisma.student.findFirst({
      where: { userId: user.id },
    });

    if (!student) {
      return [];
    }

    // Build enrollment filter - get ALL enrollments for grades (not just active)
    // This ensures we can see grades from all enrollments
    const enrollmentFilter: any = {};

    // Filter by school if provided
    if (schoolId) {
      enrollmentFilter.schoolId = schoolId;
    }

    // If classId is provided, check if it's a ClassArm or Class
    if (filters?.classId) {
      // Check if it's a ClassArm
      const classArm = await this.prisma.classArm.findUnique({
        where: { id: filters.classId },
      });

      if (classArm) {
        enrollmentFilter.classArmId = filters.classId;
      } else {
        enrollmentFilter.classId = filters.classId;
      }
    }

    // Get all enrollments for this student (including inactive for historical grades)
    const enrollments = await this.prisma.enrollment.findMany({
      where: {
        studentId: student.id,
        ...enrollmentFilter,
      },
      include: {
        classArm: {
          include: {
            classLevel: true,
          },
        },
      },
    });

    if (enrollments.length === 0) {
      return [];
    }

    const enrollmentIds = enrollments.map((e) => e.id);

    // Build where clause - only published grades
    const where: any = {
      enrollmentId: { in: enrollmentIds },
      isPublished: true, // Only published grades
    };

    if (filters?.subject) {
      where.subject = filters.subject;
    }

    if (filters?.termId) {
      where.termId = filters.termId;
    }

    // Get grades
    const grades = await this.prisma.grade.findMany({
      where,
      include: {
        enrollment: {
          include: {
            class: {
              select: {
                id: true,
                name: true,
              },
            },
            classArm: {
              include: {
                classLevel: {
                  select: {
                    id: true,
                    name: true,
                  },
                },
              },
            },
          },
        },
        teacher: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            subject: true,
          },
        },
      },
      orderBy: [{ academicYear: 'desc' }, { term: 'desc' }, { createdAt: 'desc' }],
    });

    return grades.map((grade) => {
      // Determine class name from either Class or ClassArm
      const className = grade.enrollment.classArm
        ? `${grade.enrollment.classArm.classLevel.name} ${grade.enrollment.classArm.name}`
        : grade.enrollment.class?.name || grade.enrollment.classLevel;

      return {
        id: grade.id,
        enrollmentId: grade.enrollmentId,
        teacherId: grade.teacherId,
        subject: grade.subject,
        gradeType: grade.gradeType,
        assessmentName: grade.assessmentName,
        score: grade.score.toNumber(),
        maxScore: grade.maxScore.toNumber(),
        percentage:
          grade.maxScore.toNumber() > 0
            ? (grade.score.toNumber() / grade.maxScore.toNumber()) * 100
            : 0,
        remarks: grade.remarks,
        assessmentDate: grade.assessmentDate?.toISOString(),
        academicYear: grade.academicYear,
        term: grade.term,
        termId: grade.termId,
        sequence: grade.sequence,
        isPublished: grade.isPublished,
        createdAt: grade.createdAt.toISOString(),
        enrollment: {
          id: grade.enrollment.id,
          classLevel: grade.enrollment.classLevel,
          className: className,
          class: grade.enrollment.class,
          classArm: grade.enrollment.classArm
            ? {
              id: grade.enrollment.classArm.id,
              name: grade.enrollment.classArm.name,
              classLevel: grade.enrollment.classArm.classLevel,
            }
            : null,
        },
        teacher: grade.teacher,
      };
    });
  }

  /**
   * Get attendance records for current student
   */
  async getMyAttendance(
    user: UserWithContext,
    schoolId: string | null,
    filters?: { classId?: string; termId?: string; startDate?: string; endDate?: string }
  ): Promise<any[]> {
    if (user.role !== 'STUDENT') {
      throw new ForbiddenException('Access denied. Student role required.');
    }

    // Get student
    const studentWhere: any = {
      userId: user.id,
    };

    if (schoolId) {
      studentWhere.enrollments = {
        some: {
          schoolId,
          isActive: true,
        },
      };
    }

    const student = await this.prisma.student.findFirst({
      where: studentWhere,
    });

    if (!student) {
      throw new NotFoundException('Student profile not found');
    }

    // Build where clause
    const where: any = {
      studentId: student.id,
    };

    if (filters?.classId) {
      where.classId = filters.classId;
    }

    if (filters?.termId) {
      where.termId = filters.termId;
    }

    if (filters?.startDate || filters?.endDate) {
      where.date = {};
      if (filters.startDate) {
        where.date.gte = new Date(filters.startDate);
      }
      if (filters.endDate) {
        where.date.lte = new Date(filters.endDate);
      }
    }

    // Get attendance records
    const attendance = await this.prisma.attendance.findMany({
      where,
      include: {
        enrollment: {
          select: {
            studentId: true,
            classId: true,
            termId: true,
          },
        },
        teacher: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
      },
      orderBy: { date: 'desc' },
    });

    return attendance.map((a) => ({
      id: a.id,
      studentId: a.enrollment.studentId,
      classId: a.enrollment.classId,
      termId: a.enrollment.termId,
      date: a.date.toISOString(),
      status: a.status,
      notes: a.remarks,
      teacher: a.teacher,
    }));
  }

  /**
   * Get accessible resources for current student
   */
  async getMyResources(
    user: UserWithContext,
    schoolId: string | null,
    filters?: { classId?: string; resourceType?: string }
  ): Promise<any[]> {
    if (user.role !== 'STUDENT') {
      throw new ForbiddenException('Access denied. Student role required.');
    }

    // Get student's active enrollments
    const studentWhere: any = {
      userId: user.id,
    };

    if (schoolId) {
      studentWhere.enrollments = {
        some: {
          schoolId,
          isActive: true,
        },
      };
    } else {
      studentWhere.enrollments = {
        some: {
          isActive: true,
        },
      };
    }

    const student = await this.prisma.student.findFirst({
      where: studentWhere,
      include: {
        enrollments: {
          where: {
            ...(schoolId ? { schoolId } : {}),
            isActive: true,
            ...(filters?.classId ? { classId: filters.classId } : {}),
          },
        },
      },
    });

    if (!student || student.enrollments.length === 0) {
      return [];
    }

    // Get classIds and classArmIds from enrollments
    const classIds = student.enrollments
      .map((e) => e.classId)
      .filter((id): id is string => id !== null);

    const classArmIds = student.enrollments
      .map((e) => e.classArmId)
      .filter((id): id is string => id !== null);

    if (classIds.length === 0 && classArmIds.length === 0) {
      return [];
    }

    // Build where clause - support both Classes and ClassArms
    const where: any = {
      OR: [
        ...(classIds.length > 0 ? [{ classId: { in: classIds }, classArmId: null }] : []),
        ...(classArmIds.length > 0 ? [{ classArmId: { in: classArmIds } }] : []),
      ],
    };

    if (filters?.resourceType) {
      where.fileType = filters.resourceType;
    }

    // Get resources
    const resources = await this.prisma.classResource.findMany({
      where,
      include: {
        class: {
          select: {
            id: true,
            name: true,
          },
        },
        classArm: {
          include: {
            classLevel: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return resources.map((r) => ({
      id: r.id,
      classId: r.classId,
      classArmId: r.classArmId,
      name: r.name,
      fileName: r.fileName,
      filePath: r.filePath,
      fileSize: r.fileSize,
      mimeType: r.mimeType,
      fileType: r.fileType,
      description: r.description,
      createdAt: r.createdAt.toISOString(),
      className: r.classArm
        ? `${r.classArm.classLevel.name} ${r.classArm.name}`
        : r.class?.name || 'Unknown',
      class: r.class,
    }));
  }

  /**
   * Get personal resources for current student
   */
  async getMyPersonalResources(user: UserWithContext): Promise<any[]> {
    if (user.role !== 'STUDENT') {
      throw new ForbiddenException('Access denied. Student role required.');
    }

    // Get student
    const student = await this.prisma.student.findFirst({
      where: {
        userId: user.id,
      },
    });

    if (!student) {
      return [];
    }

    // Get personal resources
    const resources = await this.prisma.studentResource.findMany({
      where: {
        studentId: student.id,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return resources.map((r) => ({
      id: r.id,
      name: r.name,
      fileName: r.fileName,
      filePath: r.filePath,
      fileSize: r.fileSize,
      mimeType: r.mimeType,
      fileType: r.fileType,
      description: r.description,
      studentId: r.studentId,
      uploadedBy: r.uploadedBy,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  /**
   * Upload personal resource for current student
   */
  async uploadPersonalResource(
    user: UserWithContext,
    file: Express.Multer.File,
    description?: string
  ): Promise<any> {
    if (user.role !== 'STUDENT') {
      throw new ForbiddenException('Access denied. Student role required.');
    }

    // Get student
    const student = await this.prisma.student.findFirst({
      where: {
        userId: user.id,
      },
    });

    if (!student) {
      throw new NotFoundException('Student not found');
    }

    // Validate file
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    // Validate file size (50MB max)
    const maxSize = 50 * 1024 * 1024;
    if (file.size > maxSize) {
      throw new BadRequestException('File size exceeds maximum limit of 50MB');
    }

    // Validate file type - only documents and spreadsheets, no images
    const allowedMimeTypes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'text/plain',
      'text/csv',
    ];

    if (!allowedMimeTypes.includes(file.mimetype)) {
      throw new BadRequestException(
        `File type ${file.mimetype} is not allowed. Only documents and spreadsheets are permitted (PDF, DOC, DOCX, XLS, XLSX, PPT, PPTX, TXT, CSV). Images are not allowed.`
      );
    }

    // Determine file type
    const fileType = this.getFileType(file.mimetype);

    // Generate unique filename
    const path = require('path');
    const { v4: uuidv4 } = require('uuid');

    const fileExtension = path.extname(file.originalname);
    const uniqueFileName = `${uuidv4()}${fileExtension}`;

    // Get school ID for folder structure
    const enrollment = await this.prisma.enrollment.findFirst({
      where: {
        studentId: student.id,
        isActive: true,
      },
      select: {
        schoolId: true,
      },
    });

    const schoolId = enrollment?.schoolId || 'unknown';

    // Upload to Cloudinary
    const folder = `schools/${schoolId}/students/${student.id}/resources`;
    const publicId = `resource-${uuidv4()}`;

    const { url: fileUrl } = await this.cloudinaryService.uploadRawFile(file, folder, publicId);

    // Create resource record
    const resource = await this.prisma.studentResource.create({
      data: {
        name: file.originalname,
        fileName: uniqueFileName,
        filePath: fileUrl, // Store Cloudinary URL in filePath for backward compatibility
        fileSize: file.size,
        mimeType: file.mimetype,
        fileType: fileType,
        description: description || null,
        studentId: student.id,
        uploadedBy: user.id,
      },
    });

    return {
      id: resource.id,
      name: resource.name,
      fileName: resource.fileName,
      filePath: resource.filePath,
      fileSize: resource.fileSize,
      mimeType: resource.mimeType,
      fileType: resource.fileType,
      description: resource.description,
      studentId: resource.studentId,
      uploadedBy: resource.uploadedBy,
      createdAt: resource.createdAt.toISOString(),
      updatedAt: resource.updatedAt.toISOString(),
    };
  }

  /**
   * Delete personal resource for current student
   */
  async deletePersonalResource(user: UserWithContext, resourceId: string): Promise<void> {
    if (user.role !== 'STUDENT') {
      throw new ForbiddenException('Access denied. Student role required.');
    }

    // Get student
    const student = await this.prisma.student.findFirst({
      where: {
        userId: user.id,
      },
    });

    if (!student) {
      throw new NotFoundException('Student not found');
    }

    // Get resource and verify ownership
    const resource = await this.prisma.studentResource.findFirst({
      where: {
        id: resourceId,
        studentId: student.id,
      },
    });

    if (!resource) {
      throw new NotFoundException('Resource not found or access denied');
    }

    // Delete file from Cloudinary or local storage
    if (resource.filePath) {
      const isCloudinaryUrl =
        resource.filePath.startsWith('http://') || resource.filePath.startsWith('https://');

      if (isCloudinaryUrl) {
        // Delete from Cloudinary
        const publicId = this.cloudinaryService.extractPublicId(resource.filePath);
        if (publicId) {
          try {
            await this.cloudinaryService.deleteRawFile(publicId);
          } catch (error) {
            this.logger.error(
              'Error deleting file from Cloudinary:',
              error instanceof Error ? error.stack : error
            );
            // Continue with database deletion even if Cloudinary deletion fails
          }
        }
      } else {
        // Backward compatibility: Delete from local filesystem for old resources
        const fs = require('fs');
        if (fs.existsSync(resource.filePath)) {
          try {
            fs.unlinkSync(resource.filePath);
          } catch (error) {
            this.logger.error(
              'Error deleting file from local storage:',
              error instanceof Error ? error.stack : error
            );
            // Continue with database deletion even if file deletion fails
          }
        }
      }
    }

    // Delete resource record
    await this.prisma.studentResource.delete({
      where: {
        id: resourceId,
      },
    });
  }

  /**
   * Get file buffer for download
   */
  async getPersonalResourceFile(
    user: UserWithContext,
    resourceId: string
  ): Promise<{ buffer: Buffer; resource: any }> {
    if (user.role !== 'STUDENT') {
      throw new ForbiddenException('Access denied. Student role required.');
    }

    // Get student
    const student = await this.prisma.student.findFirst({
      where: {
        userId: user.id,
      },
    });

    if (!student) {
      throw new NotFoundException('Student not found');
    }

    // Get resource and verify ownership
    const resource = await this.prisma.studentResource.findFirst({
      where: {
        id: resourceId,
        studentId: student.id,
      },
    });

    if (!resource) {
      throw new NotFoundException('Resource not found or access denied');
    }

    if (!resource.filePath) {
      throw new NotFoundException('File URL not found');
    }

    // Check if filePath is a Cloudinary URL (starts with http/https and contains cloudinary.com)
    const isCloudinaryUrl =
      resource.filePath.startsWith('http://') || resource.filePath.startsWith('https://');

    if (isCloudinaryUrl) {
      // Fetch file from Cloudinary URL
      try {
        const response = await fetch(resource.filePath);
        if (!response.ok) {
          throw new NotFoundException('File not found on Cloudinary');
        }
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        return {
          buffer,
          resource: {
            id: resource.id,
            name: resource.name,
            fileName: resource.fileName,
            filePath: resource.filePath,
            fileSize: resource.fileSize,
            mimeType: resource.mimeType,
            fileType: resource.fileType,
            description: resource.description,
            studentId: resource.studentId,
            uploadedBy: resource.uploadedBy,
            createdAt: resource.createdAt.toISOString(),
            updatedAt: resource.updatedAt.toISOString(),
          },
        };
      } catch (error) {
        this.logger.error(
          'Error fetching file from Cloudinary:',
          error instanceof Error ? error.stack : error
        );
        throw new NotFoundException('Failed to fetch file from Cloudinary');
      }
    } else {
      // Backward compatibility: Read from local filesystem for old resources
      const fs = require('fs');
      if (!fs.existsSync(resource.filePath)) {
        throw new NotFoundException('File not found on disk');
      }

      // Prevent path traversal for local legacy files
      const safePath = safeResolvePath(process.cwd(), resource.filePath);
      const buffer = fs.readFileSync(safePath);

      return {
        buffer,
        resource: {
          id: resource.id,
          name: resource.name,
          fileName: resource.fileName,
          filePath: resource.filePath,
          fileSize: resource.fileSize,
          mimeType: resource.mimeType,
          fileType: resource.fileType,
          description: resource.description,
          studentId: resource.studentId,
          uploadedBy: resource.uploadedBy,
          createdAt: resource.createdAt.toISOString(),
          updatedAt: resource.updatedAt.toISOString(),
        },
      };
    }
  }

  /**
   * Determine file type from MIME type
   */
  private getFileType(mimeType: string): string {
    if (mimeType.startsWith('image/')) {
      return 'IMAGE';
    } else if (mimeType === 'application/pdf') {
      return 'PDF';
    } else if (
      mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      mimeType === 'application/msword'
    ) {
      return 'DOCX';
    } else if (
      mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      mimeType === 'application/vnd.ms-excel'
    ) {
      return 'XLSX';
    } else if (
      mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
      mimeType === 'application/vnd.ms-powerpoint'
    ) {
      return 'PPTX';
    } else {
      return 'OTHER';
    }
  }

  /**
   * Get calendar data for current student (events + timetable)
   */
  async getMyCalendar(
    user: UserWithContext,
    schoolId: string | null,
    startDate?: string,
    endDate?: string
  ): Promise<any> {
    if (user.role !== 'STUDENT') {
      throw new ForbiddenException('Access denied. Student role required.');
    }

    // If schoolId not provided, get from student's active enrollment
    let actualSchoolId = schoolId;
    if (!actualSchoolId) {
      const student = await this.prisma.student.findFirst({
        where: { userId: user.id },
        include: {
          enrollments: {
            where: { isActive: true },
            orderBy: { enrollmentDate: 'desc' },
            take: 1,
          },
        },
      });

      if (!student || student.enrollments.length === 0) {
        return { events: [], timetable: [] };
      }

      actualSchoolId = student.enrollments[0].schoolId;
    }

    if (!actualSchoolId) {
      return { events: [], timetable: [] };
    }

    const start = startDate ? new Date(startDate) : new Date();
    const end = endDate ? new Date(endDate) : new Date();
    end.setDate(end.getDate() + 30); // Default to next 30 days

    // Get school to determine school type
    const school = await this.prisma.school.findUnique({
      where: { id: actualSchoolId },
      select: { hasPrimary: true, hasSecondary: true, hasTertiary: true },
    });

    let schoolType: 'PRIMARY' | 'SECONDARY' | 'TERTIARY' | undefined;
    if (school?.hasPrimary) schoolType = 'PRIMARY';
    else if (school?.hasSecondary) schoolType = 'SECONDARY';
    else if (school?.hasTertiary) schoolType = 'TERTIARY';

    // Get events
    const events = await this.eventService.getEvents(actualSchoolId, start, end, schoolType);

    // Get timetable (for current term)
    const timetable = await this.getMyTimetable(user, actualSchoolId);

    return {
      events,
      timetable,
    };
  }

  /**
   * Get complete transcript across all schools (via UID)
   */
  async getMyTranscript(
    user: UserWithContext,
    filters?: { startDate?: string; endDate?: string; schoolId?: string }
  ): Promise<any> {
    if (user.role !== 'STUDENT') {
      throw new ForbiddenException('Access denied. Student role required.');
    }

    // Get student by userId to get UID
    const student = await this.prisma.student.findFirst({
      where: { userId: user.id },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            phone: true,
          },
        },
      },
    });

    if (!student) {
      throw new NotFoundException('Student profile not found');
    }

    const uid = student.uid;

    // Get all enrollments across all schools using UID
    const allEnrollments = await this.prisma.enrollment.findMany({
      where: {
        student: { uid },
        ...(filters?.schoolId ? { schoolId: filters.schoolId } : {}),
      },
      include: {
        school: {
          select: {
            id: true,
            name: true,
            
          },
        },
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
      orderBy: { enrollmentDate: 'desc' },
    });

    // Get all published grades across all schools
    const enrollmentIds = allEnrollments.map((e) => e.id);
    const whereGrades: any = {
      enrollmentId: { in: enrollmentIds },
      isPublished: true,
    };

    if (filters?.startDate || filters?.endDate) {
      whereGrades.createdAt = {};
      if (filters.startDate) {
        whereGrades.createdAt.gte = new Date(filters.startDate);
      }
      if (filters.endDate) {
        whereGrades.createdAt.lte = new Date(filters.endDate);
      }
    }

    const allGrades = await this.prisma.grade.findMany({
      where: whereGrades,
      include: {
        enrollment: {
          include: {
            school: {
              select: {
                id: true,
                name: true,
              },
            },
            classArm: {
              include: {
                classLevel: {
                  select: {
                    id: true,
                    name: true,
                  },
                },
              },
            },
          },
        },
        teacher: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
      },
      orderBy: [{ academicYear: 'desc' }, { term: 'desc' }, { createdAt: 'desc' }],
    });

    // Get all transfers
    const allTransfers = await this.prisma.transfer.findMany({
      where: {
        studentId: student.id,
      },
      include: {
        fromSchool: {
          select: {
            id: true,
            name: true,
          },
        },
        toSchool: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Group by school
    const schoolsMap = new Map();
    allEnrollments.forEach((enrollment) => {
      const schoolId = enrollment.schoolId;
      if (!schoolsMap.has(schoolId)) {
        schoolsMap.set(schoolId, {
          school: enrollment.school,
          enrollments: [],
          grades: [],
          attendance: [],
          startDate: enrollment.enrollmentDate,
          endDate: null,
        });
      }
      schoolsMap.get(schoolId).enrollments.push(enrollment);
      if (enrollment.enrollmentDate < schoolsMap.get(schoolId).startDate) {
        schoolsMap.get(schoolId).startDate = enrollment.enrollmentDate;
      }
    });

    // Add grades to schools
    allGrades.forEach((grade) => {
      const schoolId = grade.enrollment.schoolId;
      if (schoolsMap.has(schoolId)) {
        // Determine class name from ClassArm or classLevel
        const className = grade.enrollment.classArm
          ? `${grade.enrollment.classArm.classLevel.name} ${grade.enrollment.classArm.name}`
          : grade.enrollment.classLevel;

        schoolsMap.get(schoolId).grades.push({
          id: grade.id,
          subject: grade.subject,
          assessmentName: grade.assessmentName,
          gradeType: grade.gradeType,
          score: grade.score.toNumber(),
          maxScore: grade.maxScore.toNumber(),
          percentage:
            grade.maxScore.toNumber() > 0
              ? (grade.score.toNumber() / grade.maxScore.toNumber()) * 100
              : 0,
          academicYear: grade.academicYear,
          term: grade.term,
          termId: grade.termId,
          className: className,
          assessmentDate: grade.assessmentDate?.toISOString(),
          teacher: grade.teacher,
        });
      }
    });

    // Calculate overall GPA
    let totalScore = 0;
    let totalMaxScore = 0;
    allGrades.forEach((grade) => {
      totalScore += grade.score.toNumber();
      totalMaxScore += grade.maxScore.toNumber();
    });
    const overallGPA = totalMaxScore > 0 ? (totalScore / totalMaxScore) * 100 : 0;

    // Build timeline
    const timeline: any[] = [];
    allEnrollments.forEach((enrollment) => {
      // Determine class name from ClassArm or classLevel
      const className = enrollment.classArm
        ? `${enrollment.classArm.classLevel.name} ${enrollment.classArm.name}`
        : enrollment.classLevel;

      timeline.push({
        type: 'enrollment',
        date: enrollment.enrollmentDate,
        school: enrollment.school,
        details: {
          classLevel: enrollment.classLevel,
          className: className,
          academicYear: enrollment.academicYear,
        },
      });
    });
    allTransfers.forEach((transfer) => {
      timeline.push({
        type: 'transfer',
        date: transfer.createdAt,
        school: transfer.toSchool,
        details: {
          fromSchool: transfer.fromSchool,
          status: transfer.status,
        },
      });
    });
    timeline.sort((a, b) => a.date.getTime() - b.date.getTime());

    return {
      student: {
        id: student.id,
        uid: student.uid,
        firstName: student.firstName,
        lastName: student.lastName,
        middleName: student.middleName,
        dateOfBirth: student.dateOfBirth.toISOString(),
      },
      schools: Array.from(schoolsMap.values()),
      overallGPA: Math.round(overallGPA * 100) / 100,
      totalCredits: allGrades.length,
      timeline,
    };
  }

  /**
   * Get all transfers for current student
   */
  async getMyTransfers(user: UserWithContext, filters?: { status?: string }): Promise<any[]> {
    if (user.role !== 'STUDENT') {
      throw new ForbiddenException('Access denied. Student role required.');
    }

    // Get student
    const student = await this.prisma.student.findFirst({
      where: { userId: user.id },
    });

    if (!student) {
      throw new NotFoundException('Student profile not found');
    }

    // Build where clause
    const where: any = {
      studentId: student.id,
    };

    if (filters?.status) {
      where.status = filters.status;
    }

    // Get transfers
    const transfers = await this.prisma.transfer.findMany({
      where,
      include: {
        fromSchool: {
          select: {
            id: true,
            name: true,
          },
        },
        toSchool: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return transfers.map((t) => ({
      id: t.id,
      studentId: t.studentId,
      fromSchoolId: t.fromSchoolId,
      toSchoolId: t.toSchoolId,
      status: t.status,
      tac: t.tac,
      tacExpiresAt: t.tacExpiresAt?.toISOString(),
      tacUsedAt: t.tacUsedAt?.toISOString(),
      approvedAt: t.approvedAt?.toISOString(),
      completedAt: t.completedAt?.toISOString(),
      rejectedAt: t.rejectedAt?.toISOString(),
      reason: t.reason,
      fromSchool: t.fromSchool,
      toSchool: t.toSchool,
      createdAt: t.createdAt.toISOString(),
    }));
  }

  /**
   * Get student's current school (from active enrollment)
   */
  /**
   * Get enrolled classes for current student with full details
   */
  async getMyClasses(user: UserWithContext): Promise<any[]> {
    if (user.role !== 'STUDENT') {
      throw new ForbiddenException('Access denied. Student role required.');
    }

    // Get student with active enrollments
    const student = await this.prisma.student.findFirst({
      where: {
        userId: user.id,
        enrollments: {
          some: {
            isActive: true,
          },
        },
      },
      include: {
        enrollments: {
          where: {
            isActive: true,
          },
          include: {
            school: {
              select: {
                id: true,
                name: true,
              },
            },
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

    if (!student || student.enrollments.length === 0) {
      return [];
    }

    const classes: any[] = [];

    for (const enrollment of student.enrollments) {
      // For PRIMARY/SECONDARY: Check if enrollment has ClassArm (schools using ClassArms)
      if (enrollment.classArmId && enrollment.classArm) {
        const classArm = enrollment.classArm;
        const classLevel = classArm.classLevel;

        // Get teachers from multiple sources for secondary schools:
        // 1. ClassTeacher records with classArmId
        // 2. The ClassArm's primary class teacher (classTeacherId)
        // 3. SubjectTeacher for subjects taught at this class level
        // 4. Teachers assigned to timetable periods for this classArm

        const teacherMap = new Map<string, any>();

        // Source 1: ClassTeacher records
        const classArmTeachers = await this.prisma.classTeacher.findMany({
          where: {
            classArmId: classArm.id,
          },
          include: {
            teacher: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                phone: true,
                subject: true,
                profileImage: true,
              },
            },
            subjectRef: {
              select: {
                name: true,
              },
            },
          },
        });

        classArmTeachers.forEach((ct) => {
          if (!teacherMap.has(ct.teacher.id)) {
            teacherMap.set(ct.teacher.id, {
              id: ct.teacher.id,
              firstName: ct.teacher.firstName,
              lastName: ct.teacher.lastName,
              email: ct.teacher.email,
              phone: ct.teacher.phone,
              subject: ct.subjectRef?.name || ct.subject || ct.teacher.subject,
              isPrimary: ct.isPrimary,
              profileImage: ct.teacher.profileImage,
            });
          }
        });

        // Source 2: ClassArm's primary class teacher
        if (classArm.classTeacherId) {
          const primaryTeacher = await this.prisma.teacher.findUnique({
            where: { id: classArm.classTeacherId },
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              phone: true,
              subject: true,
              profileImage: true,
            },
          });
          if (primaryTeacher && !teacherMap.has(primaryTeacher.id)) {
            teacherMap.set(primaryTeacher.id, {
              ...primaryTeacher,
              isPrimary: true,
            });
          }
        }

        // Source 3: Teachers from timetable periods for this classArm
        // Get the active term - MUST filter by schoolType (classLevel.type) to get correct session
        const activeTerm = await this.prisma.term.findFirst({
          where: {
            status: 'ACTIVE',
            academicSession: {
              schoolId: enrollment.schoolId,
              status: 'ACTIVE',
              schoolType: classLevel.type, // Critical: use the class level's type
            },
          },
        });

        if (activeTerm) {
          const timetablePeriods = await this.prisma.timetablePeriod.findMany({
            where: {
              classArmId: classArm.id,
              termId: activeTerm.id,
              teacherId: { not: null },
            },
            include: {
              teacher: {
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                  email: true,
                  phone: true,
                  subject: true,
                  profileImage: true,
                },
              },
              subject: {
                select: {
                  name: true,
                },
              },
            },
          });

          timetablePeriods.forEach((period) => {
            if (period.teacher && !teacherMap.has(period.teacher.id)) {
              teacherMap.set(period.teacher.id, {
                id: period.teacher.id,
                firstName: period.teacher.firstName,
                lastName: period.teacher.lastName,
                email: period.teacher.email,
                phone: period.teacher.phone,
                subject: period.subject?.name || period.teacher.subject,
                isPrimary: false,
                profileImage: period.teacher.profileImage,
              });
            }
          });
        }

        const allTeachers = Array.from(teacherMap.values());

        // Get ClassArm resources (or ClassLevel resources if shared)
        const classArmResources = await this.prisma.classResource.findMany({
          where: {
            OR: [
              { classArmId: classArm.id },
              // Could also include ClassLevel resources if shared
            ],
          },
          orderBy: { createdAt: 'desc' },
          take: 10,
        });

        // Count students in this ClassArm
        const studentsCount = await this.prisma.enrollment.count({
          where: {
            classArmId: classArm.id,
            isActive: true,
          },
        });

        classes.push({
          id: classArm.id,
          name: `${classLevel.name} ${classArm.name}`, // e.g., "JSS 1 Gold"
          code: null,
          classLevel: classLevel.name,
          classLevelId: classLevel.id,
          type: classLevel.type,
          academicYear: classArm.academicYear,
          description: null,
          teachers: allTeachers,
          resources: classArmResources.map((r) => ({
            id: r.id,
            name: r.name,
            fileName: r.fileName,
            fileType: r.fileType,
            mimeType: r.mimeType,
            description: r.description,
            createdAt: r.createdAt.toISOString(),
          })),
          enrollment: {
            id: enrollment.id,
            enrollmentDate: enrollment.enrollmentDate.toISOString(),
            school: enrollment.school,
            classArmId: enrollment.classArmId,
          },
          classArmId: enrollment.classArmId,
          classArm: {
            id: classArm.id,
            name: classArm.name,
            capacity: classArm.capacity,
          },
        });
        continue;
      }

      // Fallback to Class (for schools without ClassArms or TERTIARY - backward compatibility)
      let classData = enrollment.class;

      // If no classId, try to find class by classLevel/name
      if (!classData && enrollment.classLevel) {
        classData = await this.prisma.class.findFirst({
          where: {
            schoolId: enrollment.schoolId,
            isActive: true,
            academicYear: enrollment.academicYear,
            OR: [{ name: enrollment.classLevel }, { classLevel: enrollment.classLevel }],
          },
          orderBy: {
            createdAt: 'desc',
          },
        });
      }

      if (!classData) {
        // If still no class found, create a minimal class object from enrollment
        classes.push({
          id: enrollment.id,
          name: enrollment.classLevel,
          classLevel: enrollment.classLevel,
          type: null,
          academicYear: enrollment.academicYear,
          teachers: [],
          resources: [],
          studentsCount: 0,
          enrollment: {
            id: enrollment.id,
            enrollmentDate: enrollment.enrollmentDate.toISOString(),
          },
        });
        continue;
      }

      // Get full class details with teachers and resources
      const fullClass = await this.prisma.class.findUnique({
        where: { id: classData.id },
        include: {
          classTeachers: {
            include: {
              teacher: {
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                  email: true,
                  phone: true,
                  subject: true,
                },
              },
            },
          },
          resources: {
            orderBy: { createdAt: 'desc' },
            take: 10,
          },
        },
      });

      if (fullClass) {
        classes.push({
          id: fullClass.id,
          name: fullClass.name,
          code: fullClass.code,
          classLevel: fullClass.classLevel,
          type: fullClass.type,
          academicYear: fullClass.academicYear,
          description: fullClass.description,
          teachers: fullClass.classTeachers.map((ct) => ({
            id: ct.teacher.id,
            firstName: ct.teacher.firstName,
            lastName: ct.teacher.lastName,
            email: ct.teacher.email,
            phone: ct.teacher.phone,
            subject: ct.subject || ct.teacher.subject,
            isPrimary: ct.isPrimary,
          })),
          resources: fullClass.resources.map((r) => ({
            id: r.id,
            name: r.name,
            fileName: r.fileName,
            fileType: r.fileType,
            mimeType: r.mimeType,
            description: r.description,
            createdAt: r.createdAt.toISOString(),
          })),
          enrollment: {
            id: enrollment.id,
            enrollmentDate: enrollment.enrollmentDate.toISOString(),
            school: enrollment.school,
            classArmId: enrollment.classArmId,
          },
          classArmId: enrollment.classArmId,
        });
      }
    }

    return classes;
  }

  /**
   * Get classmates (students in the same class)
   */
  async getMyClassmates(user: UserWithContext, classId?: string): Promise<any[]> {
    if (user.role !== 'STUDENT') {
      throw new ForbiddenException('Access denied. Student role required.');
    }

    // Get current student's active enrollment
    const student = await this.prisma.student.findFirst({
      where: {
        userId: user.id,
        enrollments: {
          some: {
            isActive: true,
            ...(user.currentSchoolId ? { schoolId: user.currentSchoolId } : {}),
          },
        },
      },
      include: {
        enrollments: {
          where: {
            isActive: true,
            ...(user.currentSchoolId ? { schoolId: user.currentSchoolId } : {}),
          },
          orderBy: { enrollmentDate: 'desc' },
          take: 1,
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

    if (!student || student.enrollments.length === 0) {
      return [];
    }

    const enrollment = student.enrollments[0];
    const targetClassId = classId || enrollment.classId;
    const schoolId = enrollment.schoolId;
    const academicYear = enrollment.academicYear;
    const classLevel = enrollment.classLevel;

    // Build where clause based on ClassArm availability
    const where: any = {
      schoolId,
      isActive: true,
      academicYear,
      studentId: { not: student.id },
    };

    // For PRIMARY/SECONDARY: Filter by ClassArm if available (schools using ClassArms)
    if (enrollment.classArmId) {
      // Filter by ClassArm - only students in the same arm
      where.classArmId = enrollment.classArmId;
    } else if (targetClassId) {
      // Fallback to Class (for schools without ClassArms or TERTIARY - backward compatibility)
      where.classId = targetClassId;
    } else if (classLevel) {
      // Fallback: Filter by ClassLevel (backward compatibility - shows all in level)
      where.classLevel = classLevel;
    } else {
      return [];
    }

    // Get all students in the same class/arm
    const enrollments = await this.prisma.enrollment.findMany({
      where,
      include: {
        student: {
          include: {
            user: {
              select: {
                id: true,
                email: true,
                phone: true,
                accountStatus: true,
              },
            },
          },
        },
      },
      orderBy: {
        student: {
          lastName: 'asc',
        },
      },
    });

    return enrollments.map((enrollment) => ({
      id: enrollment.student.id,
      uid: enrollment.student.uid,
      firstName: enrollment.student.firstName,
      middleName: enrollment.student.middleName,
      lastName: enrollment.student.lastName,
      profileImage: enrollment.student.profileImage,
      dateOfBirth: enrollment.student.dateOfBirth.toISOString().split('T')[0],
      enrollment: {
        id: enrollment.id,
        classLevel: enrollment.classLevel,
        academicYear: enrollment.academicYear,
        enrollmentDate: enrollment.enrollmentDate.toISOString(),
      },
      user: enrollment.student.user,
    }));
  }

  async getMySchool(user: UserWithContext): Promise<any> {
    if (user.role !== 'STUDENT') {
      throw new ForbiddenException('Access denied. Student role required.');
    }

    // Get student with active enrollment
    const student = await this.prisma.student.findFirst({
      where: {
        userId: user.id,
        enrollments: {
          some: {
            isActive: true,
            ...(user.currentSchoolId ? { schoolId: user.currentSchoolId } : {}),
          },
        },
      },
      include: {
        enrollments: {
          where: {
            isActive: true,
          },
          orderBy: { enrollmentDate: 'desc' },
          take: 1,
          include: {
            school: {
              select: {
                id: true,
                name: true,
                logo: true,
                hasPrimary: true,
                hasSecondary: true,
                hasTertiary: true,
                schoolId: true,
                slug: true,
                customDomain: true,
                customDomainStatus: true,
                branding: true,
              },
            },
          },
        },
      },
    });

    if (!student || student.enrollments.length === 0) {
      throw new BadRequestException('You are not associated with any school');
    }

    const school = student.enrollments[0].school;

    // Compute school type info
    const availableTypes: string[] = [];
    if (school.hasPrimary) availableTypes.push('PRIMARY');
    if (school.hasSecondary) availableTypes.push('SECONDARY');
    if (school.hasTertiary) availableTypes.push('TERTIARY');

    const isMixed = availableTypes.length > 1;
    const primaryType = isMixed ? 'MIXED' : availableTypes[0] || 'PRIMARY';

    const runtimePolicies = await this.schoolSettingsService.getRuntimePolicies(school.id);

    return {
      ...school,
      schoolType: {
        hasPrimary: school.hasPrimary,
        hasSecondary: school.hasSecondary,
        hasTertiary: school.hasTertiary,
        isMixed,
        availableTypes,
        primaryType,
      },
      runtimePolicies,
    };
  }

  /**
   * Update student profile
   */
  async updateStudent(
    schoolId: string,
    studentId: string,
    updateData: {
      firstName?: string;
      middleName?: string;
      lastName?: string;
      phone?: string;
      nationality?: string;
      state?: string;
      bloodGroup?: string;
      allergies?: string;
      medications?: string;
      emergencyContact?: string;
      emergencyContactPhone?: string;
      medicalNotes?: string;
    }
  ): Promise<StudentWithEnrollmentDto> {
    // Verify student exists in this school
    const existingStudent = await this.findOne(schoolId, studentId);

    // Build update data
    const studentUpdateData: any = {};
    if (updateData.firstName !== undefined) studentUpdateData.firstName = updateData.firstName;
    if (updateData.middleName !== undefined)
      studentUpdateData.middleName = updateData.middleName || null;
    if (updateData.lastName !== undefined) studentUpdateData.lastName = updateData.lastName;
    if (updateData.nationality !== undefined) studentUpdateData.nationality = updateData.nationality || null;
    if (updateData.state !== undefined) studentUpdateData.state = updateData.state || null;

    // Build health info object
    const healthInfo: any = {};
    if (updateData.bloodGroup !== undefined) healthInfo.bloodGroup = updateData.bloodGroup || null;
    if (updateData.allergies !== undefined) healthInfo.allergies = updateData.allergies || null;
    if (updateData.medications !== undefined)
      healthInfo.medications = updateData.medications || null;
    if (updateData.emergencyContact !== undefined)
      healthInfo.emergencyContact = updateData.emergencyContact || null;
    if (updateData.emergencyContactPhone !== undefined)
      healthInfo.emergencyContactPhone = updateData.emergencyContactPhone || null;
    if (updateData.medicalNotes !== undefined)
      healthInfo.medicalNotes = updateData.medicalNotes || null;

    // Only update healthInfo if at least one health field is provided
    if (Object.keys(healthInfo).length > 0) {
      // Get existing healthInfo and merge
      const existingHealthInfo = existingStudent.healthInfo || {};
      studentUpdateData.healthInfo = { ...existingHealthInfo, ...healthInfo };
    }

    // Update user phone if provided
    if (updateData.phone !== undefined) {
      const student = await this.prisma.student.findUnique({
        where: { id: studentId },
        select: { userId: true },
      });

      if (student?.userId) {
        await this.prisma.user.update({
          where: { id: student.userId },
          data: { phone: updateData.phone || null },
        });
      }
    }

    // Update student
    const updatedStudent = await this.prisma.student.update({
      where: { id: studentId },
      data: studentUpdateData,
      include: {
        user: {
          select: {
            id: true,
            email: true,
            phone: true,
            accountStatus: true,
          },
        },
        enrollments: {
          where: {
            schoolId: schoolId,
            isActive: true,
          },
          include: {
            school: {
              select: {
                id: true,
                name: true,
                
              },
            },
          },
          take: 1,
          orderBy: { enrollmentDate: 'desc' },
        },
      },
    });

    return {
      ...this.toDto(updatedStudent),
      enrollment: updatedStudent.enrollments[0]
        ? {
          id: updatedStudent.enrollments[0].id,
          classLevel: updatedStudent.enrollments[0].classLevel,
          academicYear: updatedStudent.enrollments[0].academicYear,
          enrollmentDate: updatedStudent.enrollments[0].enrollmentDate.toISOString(),
          school: updatedStudent.enrollments[0].school,
        }
        : undefined,
    };
  }

  /**
   * Upload student profile image
   */
  async uploadProfileImage(user: UserWithContext, file: Express.Multer.File): Promise<any> {
    if (user.role !== 'STUDENT') {
      throw new ForbiddenException('Access denied. Student role required.');
    }

    // Get student
    const student = await this.prisma.student.findFirst({
      where: {
        userId: user.id,
      },
    });

    if (!student) {
      throw new NotFoundException('Student not found');
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

    // Get school ID from user context or from student's active enrollment
    let schoolId = user.currentSchoolId;
    if (!schoolId) {
      const enrollment = await this.prisma.enrollment.findFirst({
        where: {
          studentId: student.id,
          isActive: true,
        },
        select: {
          schoolId: true,
        },
        orderBy: {
          enrollmentDate: 'desc',
        },
      });
      if (enrollment) {
        schoolId = enrollment.schoolId;
      }
    }

    if (!schoolId) {
      throw new BadRequestException('Student is not enrolled in any school');
    }

    // Delete old image if exists
    if (student.profileImage) {
      const oldPublicId = this.cloudinaryService.extractPublicId(student.profileImage);
      if (oldPublicId) {
        try {
          await this.cloudinaryService.deleteImage(oldPublicId);
        } catch (error) {
          this.logger.error(
            'Error deleting old profile image:',
            error instanceof Error ? error.stack : error
          );
          // Continue even if deletion fails
        }
      }
    }

    // Upload to Cloudinary
    const { url } = await this.cloudinaryService.uploadImage(
      file,
      `schools/${schoolId}/students`,
      `student-${student.id}`
    );

    // Update student with new image URL
    const updatedStudent = await this.prisma.student.update({
      where: { id: student.id },
      data: { profileImage: url },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            phone: true,
            accountStatus: true,
          },
        },
      },
    });

    return this.toDto(updatedStudent);
  }

  /**
   * Get dashboard statistics for current student (Pulse and Distribution)
   * Scoped to current school and active term
   */
  async getMyDashboardStats(user: UserWithContext): Promise<any> {
    if (!user.id) {
      throw new BadRequestException('User ID is missing');
    }

    // Find student by userId
    const student = await this.prisma.student.findFirst({
      where: { userId: user.id },
      include: {
        enrollments: {
          where: {
            isActive: true,
            ...(user.currentSchoolId ? { schoolId: user.currentSchoolId } : {}),
          },
          include: {
            class: true,
            classArm: {
                include: { classLevel: true }
            }
          },
          orderBy: { enrollmentDate: 'desc' },
          take: 1
        },
      },
    });

    if (!student || student.enrollments.length === 0) {
      return { 
        averageScore: 0, 
        subjectBreakdown: [],
        totalGrades: 0,
        recentGradesCount: 0
      };
    }

    const enrollment = student.enrollments[0];
    const enrollmentId = enrollment.id;
    const schoolId = enrollment.schoolId;

    // Determine schoolType for correct session lookup
    let schoolType: string | null = null;
    if (enrollment.classArm?.classLevel?.type) {
      schoolType = enrollment.classArm.classLevel.type;
    } else if (enrollment.class?.type) {
      schoolType = enrollment.class.type;
    }

    // Find active term for this school and schoolType
    const activeSession = await this.prisma.academicSession.findFirst({
      where: {
        schoolId,
        status: 'ACTIVE',
        ...(schoolType ? { schoolType } : {}),
      },
      include: {
        terms: {
          where: { status: 'ACTIVE' },
          take: 1,
        },
      },
    });

    const activeTermId = activeSession?.terms[0]?.id;

    // Get all published grades for this enrollment and term
    const grades = await this.prisma.grade.findMany({
      where: {
        enrollmentId,
        isPublished: true,
        ...(activeTermId ? { termId: activeTermId } : {}),
      },
    });

    // Calculate Pulse (Weighted Average) and Distribution
    let totalScore = 0;
    let totalMaxScore = 0;
    const subjectMap: Record<string, { total: number; max: number; count: number }> = {};
    
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    let recentGradesCount = 0;

    grades.forEach(grade => {
      const score = Number(grade.score);
      const max = Number(grade.maxScore);
      totalScore += score;
      totalMaxScore += max;

      const subjectName = grade.subject || 'General';
      if (!subjectMap[subjectName]) {
        subjectMap[subjectName] = { total: 0, max: 0, count: 0 };
      }
      subjectMap[subjectName].total += score;
      subjectMap[subjectName].max += max;
      subjectMap[subjectName].count += 1;
      
      if (grade.updatedAt >= sevenDaysAgo) {
        recentGradesCount++;
      }
    });

    const averageScore = totalMaxScore > 0 
      ? Math.round((totalScore / totalMaxScore) * 100) 
      : 0;

    const subjectBreakdown = Object.entries(subjectMap).map(([name, data]) => ({
      name,
      percentage: data.max > 0 ? Math.round((data.total / data.max) * 100) : 0,
      count: data.count,
    })).sort((a, b) => b.percentage - a.percentage);

    return {
      averageScore,
      subjectBreakdown,
      totalGrades: grades.length,
      recentGradesCount,
    };
  }

  /**
   * Reassign a student to a different class/arm
   * Handles same-level moves freely for authorized admins
   * Restricts cross-level moves (higher/lower) to Principal roles only
   */
  async reassignStudent(
    schoolId: string,
    studentId: string,
    dto: ReassignStudentDto,
    adminProfileId: string | null | undefined,
    adminName: string
  ): Promise<any> {
    // 1. Find student and their current active enrollment
    const enrollment = await this.prisma.enrollment.findFirst({
      where: {
        studentId,
        schoolId,
        isActive: true,
      },
      include: {
        student: true,
      },
    });

    if (!enrollment) {
      throw new NotFoundException('We could not find an active enrollment record for this student in your school.');
    }

    // 2. Validate move sensitivity (Level Change)
    // Read the tier from the database, not the token: a title on a stale JWT
    // must not decide whether a cross-level move is allowed.
    const isLevelChange = enrollment.classLevel !== dto.targetClassLevel;
    const requestingAdmin = adminProfileId
      ? await this.prisma.schoolAdmin.findFirst({
          where: { id: adminProfileId, schoolId },
          select: { id: true, accessTier: true },
        })
      : null;
    const isPrincipal = hasPrincipalAccess(requestingAdmin);

    if (isLevelChange && !isPrincipal) {
      throw new ForbiddenException(
        'Moving a student to a different grade level (e.g., JSS 1 to JSS 2) requires Principal or Head Teacher approval.'
      );
    }

    // 3. Validate target Class/Arm
    let targetClassId = dto.targetClassId || null;
    let targetClassArmId = dto.targetClassArmId || null;

    if (dto.targetClassArmId) {
      const classArm = await this.prisma.classArm.findUnique({
        where: { id: dto.targetClassArmId },
        include: { classLevel: true },
      });

      if (!classArm || classArm.classLevel.schoolId !== schoolId) {
        throw new BadRequestException('The selected class could not be found in your school records.');
      }

      // Validate level match if moving to specific arm
      if (classArm.classLevel.name !== dto.targetClassLevel) {
        throw new BadRequestException(`The selected class group (${classArm.name}) does not belong to the ${dto.targetClassLevel} level.`);
      }

      // Check capacity
      if (classArm.capacity !== null) {
        const currentCount = await this.prisma.enrollment.count({
          where: {
            classArmId: classArm.id,
            isActive: true,
            academicYear: dto.academicYear,
          },
        });

        if (currentCount >= classArm.capacity) {
          throw new BadRequestException(
            `The class "${classArm.name}" is already at its maximum capacity of ${classArm.capacity} students.`
          );
        }
      }
      
      targetClassArmId = classArm.id;
    } else if (dto.targetClassLevel) {
      // Find matching class if no arm provided (fallback/tertiary)
      const matchingClass = await this.prisma.class.findFirst({
        where: {
          schoolId,
          academicYear: dto.academicYear,
          OR: [{ name: dto.targetClassLevel }, { classLevel: dto.targetClassLevel }],
          isActive: true,
        },
      });
      if (matchingClass) targetClassId = matchingClass.id;
    }

    // 4. Perform reassignment in transaction
    return await this.prisma.$transaction(async (tx) => {
      // Deactivate old enrollment
      await tx.enrollment.update({
        where: { id: enrollment.id },
        data: { isActive: false },
      });

      // Create new enrollment
      const newEnrollment = await tx.enrollment.create({
        data: {
          studentId: enrollment.studentId,
          schoolId,
          classLevel: dto.targetClassLevel,
          academicYear: dto.academicYear,
          classId: targetClassId,
          classArmId: targetClassArmId,
          termId: enrollment.termId, // Keep original term or find active
          isActive: true,
        },
      });

      // 5. Notify Form Teachers (Outside transaction but using result data)
      try {
        const student = enrollment.student;
        const studentName = `${student.firstName} ${student.lastName}`;

        // Find form teachers for both classes to notify them
        const notifiedTeachers = await this.prisma.classTeacher.findMany({
          where: {
            AND: [
              {
                OR: [
                  { classArmId: enrollment.classArmId }, // Moved from
                  { classArmId: targetClassArmId },      // Moved to
                ],
              },
              {
                OR: [
                  { isPrimary: true },
                  { isFormTeacher: true },
                ],
              }
            ]
          },
          select: {
            teacherId: true,
            classArm: {
              select: {
                name: true,
                classLevel: { select: { name: true } },
              }
            }
          }
        });

        const teacherIds = [...new Set(notifiedTeachers.map(t => t.teacherId))];

        if (teacherIds.length > 0) {
          // Get class names for better notification content
          const oldClassName = enrollment.classArmId ? 
            await this.prisma.classArm.findUnique({ 
              where: { id: enrollment.classArmId }, 
              include: { classLevel: true } 
            }).then(c => c ? `${c.classLevel.name} ${c.name}` : enrollment.classLevel) : 
            enrollment.classLevel;

          const newClassName = targetClassArmId ? 
            await this.prisma.classArm.findUnique({ 
              where: { id: targetClassArmId }, 
              include: { classLevel: true } 
            }).then(c => c ? `${c.classLevel.name} ${c.name}` : dto.targetClassLevel) : 
            dto.targetClassLevel;

          this.notificationService.emitStudentReassigned({
            schoolId,
            studentId,
            studentName,
            oldClassName,
            newClassName,
            adminName,
            teacherIds,
            timestamp: new Date().toISOString(),
          });
        }
      } catch (err) {
        this.logger.error(`Failed to send reassignment notifications: ${err.message}`);
      }

      return {
        message: 'Student reassigned successfully',
        studentId,
        newEnrollmentId: newEnrollment.id,
        isLevelChange,
      };
    });
  }
}

