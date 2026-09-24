import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { EmailService } from '../../email/email.service';
import { SchoolRepository } from '../domain/repositories/school.repository';
import { StaffRepository } from '../domain/repositories/staff.repository';
import { CreateClassDto, ClassType } from '../dto/create-class.dto';
import { AssignTeacherToClassDto } from '../dto/assign-teacher-to-class.dto';
import { ClassDto } from '../dto/class.dto';
import { SchoolValidatorService } from '../shared/school-validator.service';
import { NotificationService } from '../../notification/notification.service';
import { SchoolSettingsService } from '../../school-settings/school-settings.service';

/**
 * Service for managing classes/courses and teacher assignments
 */
@Injectable()
export class ClassService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly schoolRepository: SchoolRepository,
    private readonly staffRepository: StaffRepository,
    private readonly emailService: EmailService,
    private readonly schoolValidator: SchoolValidatorService,
    private readonly notificationService: NotificationService,
    private readonly schoolSettingsService: SchoolSettingsService,
  ) { }

  // Access Prisma models using bracket notation for reserved keywords
  private get classModel() {
    return (this.prisma as any)['class'];
  }

  private get classTeacherModel() {
    return (this.prisma as any)['classTeacher'];
  }

  private get classArmModel() {
    return (this.prisma as any)['classArm'];
  }

  private get classLevelModel() {
    return (this.prisma as any)['classLevel'];
  }

  /**
   * Check if school uses ClassArms (has any ClassArms for PRIMARY/SECONDARY)
   */
  private async schoolUsesClassArms(
    schoolId: string,
    academicYear: string,
    typeFilter?: ClassType
  ): Promise<boolean> {
    const where: any = {
      classLevel: {
        schoolId,
      },
      academicYear,
      isActive: true,
    };

    // Filter by type if provided
    if (typeFilter && typeFilter !== ClassType.TERTIARY) {
      where.classLevel = {
        ...where.classLevel,
        type: typeFilter,
      };
    } else {
      // For PRIMARY/SECONDARY only (TERTIARY doesn't use ClassArms)
      where.classLevel = {
        ...where.classLevel,
        type: { in: ['PRIMARY', 'SECONDARY'] },
      };
    }

    const classArmCount = await this.classArmModel.count({ where });
    return classArmCount > 0;
  }

  /**
   * Create a new class/course
   */
  async createClass(schoolId: string, classData: CreateClassDto): Promise<ClassDto> {
    // Validate school exists
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }
    await this.schoolValidator.validateSchoolActive(school.id);

    // PRIMARY/SECONDARY must use ClassArms — do not create legacy Class rows
    if (classData.type === 'PRIMARY' || classData.type === 'SECONDARY') {
      throw new BadRequestException(
        'Primary and secondary classes must be created as class arms (level + section). Use POST /timetable/class-arms or Generate Default Classes.',
      );
    }

    // Validate school type matches class type
    this.validateSchoolTypeForClass(school, classData.type);

    // Create class (TERTIARY courses)
    const newClass = await this.classModel.create({
      data: {
        name: classData.name,
        code: classData.code || null,
        classLevel: classData.classLevel || null,
        type: classData.type,
        academicYear: classData.academicYear,
        creditHours: classData.creditHours || null,
        description: classData.description || null,
        schoolId: school.id,
      },
      include: {
        classTeachers: {
          include: {
            teacher: true,
          },
        },
      },
    });

    return this.mapToClassDto(newClass);
  }

  /**
   * Get current academic year (e.g., "2024/2025")
   */
  private getCurrentAcademicYear(): string {
    const now = new Date();
    const currentYear = now.getFullYear();
    const month = now.getMonth(); // 0-11

    // Academic year typically starts in September (month 8)
    // If we're before September, use previous year as start
    if (month < 8) {
      return `${currentYear - 1}/${currentYear}`;
    } else {
      return `${currentYear}/${currentYear + 1}`;
    }
  }

  /**
   * Get classes assigned to a teacher
   * For PRIMARY: Returns ClassArms from ClassTeacher records (form teacher)
   * For SECONDARY: Returns ClassArms from TimetablePeriod records (timetable-based assignments)
   * For TERTIARY: Returns Classes (backward compatibility)
   */
  async getTeacherClasses(schoolId: string, teacherId: string): Promise<ClassDto[]> {
    // Validate school exists
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    // Validate teacher exists in school - check both id and teacherId fields
    const teacher = await this.prisma.teacher.findFirst({
      where: {
        OR: [{ id: teacherId }, { teacherId: teacherId }],
        schoolId: school.id,
      },
    });
    if (!teacher) {
      throw new NotFoundException('Teacher not found in this school');
    }

    const structure = await this.schoolSettingsService.getStructureConfig(school.id);
    if (structure.teacherScope === 'ALL_SCHOOL') {
      const academicYearAll = this.getCurrentAcademicYear();
      const [arms, tertiary] = await Promise.all([
        this.getClasses(schoolId, academicYearAll),
        this.getClasses(schoolId, academicYearAll, ClassType.TERTIARY),
      ]);
      const byId = new Map<string, ClassDto>();
      for (const cls of [...arms, ...tertiary]) byId.set(cls.id, cls);
      return [...byId.values()];
    }

    // Get current academic year
    const academicYear = this.getCurrentAcademicYear();

    // Check if school uses ClassArms (for PRIMARY/SECONDARY)
    const usesClassArms = await this.schoolUsesClassArms(school.id, academicYear);

    if (usesClassArms) {
      // Get unique ClassArm IDs from multiple sources:
      // 1. ClassTeacher records (form teacher assignments - PRIMARY)
      // 2. TimetablePeriod records (timetable-based assignments - SECONDARY)
      const classArmIds = new Set<string>();

      // 1. Get ClassArms from ClassTeacher records (form teacher for PRIMARY)
      const classTeacherAssignments = await (this.prisma as any).classTeacher.findMany({
        where: {
          teacherId: teacher.id,
          classArmId: { not: null },
          classArm: {
            isActive: true,
            classLevel: {
              schoolId: school.id,
            },
          },
        },
        select: {
          classArmId: true,
        },
      });
      classTeacherAssignments.forEach((ct: any) => {
        if (ct.classArmId) classArmIds.add(ct.classArmId);
      });

      // 2. Get ClassArms from TimetablePeriod records (for SECONDARY schools)
      // This is where teachers are assigned via timetable
      const timetablePeriods = await this.prisma.timetablePeriod.findMany({
        where: {
          teacherId: teacher.id,
          classArmId: { not: null },
          type: 'LESSON',
        },
        select: {
          classArmId: true,
        },
        distinct: ['classArmId'],
      });
      timetablePeriods.forEach((period: any) => {
        if (period.classArmId) classArmIds.add(period.classArmId);
      });

      // If no classes found, return empty array
      if (classArmIds.size === 0) {
        return [];
      }

      // Fetch full ClassArm data for all collected IDs
      const classArms = await (this.prisma as any).classArm.findMany({
        where: {
          id: { in: Array.from(classArmIds) },
          isActive: true,
          classLevel: {
            schoolId: school.id,
          },
        },
        include: {
          classLevel: true,
          classTeachers: {
            include: {
              teacher: true,
            },
          },
        },
        orderBy: [{ classLevel: { level: 'asc' } }, { name: 'asc' }],
      });

      // Get student counts and subject info for each ClassArm
      const classArmsWithCounts = await Promise.all(
        classArms.map(async (arm: any) => {
          const studentsCount = await this.prisma.enrollment.count({
            where: {
              schoolId: school.id,
              classArmId: arm.id,
              isActive: true,
              academicYear,
            },
          });

          // For SECONDARY, get the subjects this teacher teaches in this class from timetable
          const subjectsInClass = await this.prisma.timetablePeriod.findMany({
            where: {
              teacherId: teacher.id,
              classArmId: arm.id,
              type: 'LESSON',
            },
            select: {
              subject: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
            distinct: ['subjectId'],
          });

          // Build teacher info - include subjects from timetable
          const teacherSubjects = subjectsInClass
            .filter((p: any) => p.subject)
            .map((p: any) => p.subject.name)
            .join(', ');

          return {
            id: arm.id,
            name: `${arm.classLevel.name} ${arm.name}`, // e.g., "JSS 1 Gold"
            code: null,
            classLevel: arm.classLevel.name,
            type: arm.classLevel.type,
            academicYear: arm.academicYear,
            description: null,
            isActive: arm.isActive,
            createdAt: arm.createdAt,
            updatedAt: arm.updatedAt,
            schoolId: school.id,
            studentsCount,
            teachers: [
              // Include the current teacher with their subjects in this class
              {
                id: `timetable-${teacher.id}-${arm.id}`,
                teacherId: teacher.id,
                firstName: teacher.firstName,
                lastName: teacher.lastName,
                email: teacher.email,
                subject: teacherSubjects || null,
                isPrimary:
                  arm.classTeachers?.some(
                    (ct: any) => ct.teacherId === teacher.id && ct.isPrimary
                  ) || false,
                isFormTeacher:
                  arm.classTeachers?.some(
                    (ct: any) => ct.teacherId === teacher.id && ct.isFormTeacher
                  ) || false,
                createdAt: arm.createdAt,
              },
              // Include other form teachers if any
              ...arm.classTeachers
                .filter((ct: any) => ct.teacherId !== teacher.id)
                .map((ct: any) => ({
                  id: ct.id,
                  teacherId: ct.teacher.id,
                  firstName: ct.teacher.firstName,
                  lastName: ct.teacher.lastName,
                  email: ct.teacher.email,
                  subject: ct.subject || ct.teacher.subject,
                  isPrimary: ct.isPrimary,
                  isFormTeacher: !!ct.isFormTeacher,
                  createdAt: ct.createdAt,
                })),
            ],
            classArmId: arm.id,
            classLevelId: arm.classLevelId,
          };
        })
      );

      return classArmsWithCounts.map((arm: any) => this.mapToClassDto(arm));
    }

    // Fallback to Classes (for schools without ClassArms or TERTIARY - backward compatibility)
    const assignments = await this.classTeacherModel.findMany({
      where: {
        teacherId: teacherId,
        classId: { not: null },
        class: {
          schoolId: school.id,
          isActive: true,
        },
      },
      include: {
        class: {
          include: {
            classTeachers: {
              include: {
                teacher: true,
              },
            },
          },
        },
      },
    });

    // Get unique classes and map to DTOs
    const classMap = new Map<string, any>();
    assignments.forEach((assignment: any) => {
      const classData = assignment.class;
      if (classData && !classMap.has(classData.id)) {
        classMap.set(classData.id, classData);
      }
    });

    // Count students for each class
    const classes = Array.from(classMap.values());
    const classesWithCounts = await Promise.all(
      classes.map(async (classData) => {
        const studentsCount = await this.prisma.enrollment.count({
          where: {
            schoolId: school.id,
            OR: [
              { classId: classData.id },
              {
                AND: [
                  { classLevel: classData.classLevel },
                  { academicYear: classData.academicYear },
                ],
              },
            ],
          },
        });

        return this.mapToClassDto({ ...classData, studentsCount });
      })
    );

    return classesWithCounts;
  }

  /**
   * Get classes as ClassArms (for schools using ClassArms)
   */
  private async getClassesAsClassArms(
    school: any,
    academicYear: string,
    typeFilter?: ClassType
  ): Promise<ClassDto[]> {
    const where: any = {
      classLevel: {
        schoolId: school.id,
      },
      academicYear,
      isActive: true,
    };

    // Filter by type if provided (only PRIMARY/SECONDARY)
    if (typeFilter && typeFilter !== ClassType.TERTIARY) {
      where.classLevel = {
        ...where.classLevel,
        type: typeFilter,
      };
    } else {
      // For PRIMARY/SECONDARY only
      where.classLevel = {
        ...where.classLevel,
        type: { in: ['PRIMARY', 'SECONDARY'] },
      };
    }

    const classArms = await this.classArmModel.findMany({
      where,
      include: {
        classLevel: true,
        classTeachers: {
          include: {
            teacher: true,
          },
        },
      },
      orderBy: [{ classLevel: { level: 'asc' } }, { name: 'asc' }],
    });

    // Get student counts for all ClassArms
    const classArmsWithCounts = await Promise.all(
      classArms.map(async (arm: any) => {
        const studentsCount = await this.prisma.enrollment.count({
          where: {
            schoolId: school.id,
            classArmId: arm.id,
            isActive: true,
            academicYear,
          },
        });

        return {
          id: arm.id,
          name: `${arm.classLevel.name} ${arm.name}`, // e.g., "JSS 1 Gold"
          code: null,
          classLevel: arm.classLevel.name,
          type: arm.classLevel.type,
          academicYear: arm.academicYear,
          description: null,
          isActive: arm.isActive,
          createdAt: arm.createdAt,
          updatedAt: arm.updatedAt,
          schoolId: school.id,
          studentsCount,
          teachers: (arm.classTeachers || []).map((ct: any) => ({
            id: ct.id,
            teacherId: ct.teacher.id,
            firstName: ct.teacher.firstName,
            lastName: ct.teacher.lastName,
            email: ct.teacher.email,
            subject: ct.subject || ct.teacher.subject,
            isPrimary: ct.isPrimary,
            isFormTeacher: !!ct.isFormTeacher,
            createdAt: ct.createdAt,
          })),
          classArmId: arm.id,
          classLevelId: arm.classLevelId,
        };
      })
    );

    return classArmsWithCounts.map((arm: any) => this.mapToClassDto(arm));
  }

  /**
   * Get all classes for a school
   * - PRIMARY/SECONDARY: Returns ClassArms only (new system)
   * - TERTIARY: Returns Classes (courses)
   * @param typeFilter - Optional filter to only get classes of a specific type (PRIMARY, SECONDARY, TERTIARY)
   */
  async getClasses(
    schoolId: string,
    academicYear?: string,
    typeFilter?: ClassType
  ): Promise<ClassDto[]> {
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    // Use provided academic year or default to current
    const targetAcademicYear = academicYear || this.getCurrentAcademicYear();

    const enrollmentCountWhere = {
      schoolId: school.id,
      isActive: true,
      academicYear: targetAcademicYear,
    };

    // For TERTIARY: Return Classes (courses)
    if (typeFilter === ClassType.TERTIARY) {
      const classes = await this.classModel.findMany({
        where: {
          schoolId: school.id,
          academicYear: targetAcademicYear,
          type: ClassType.TERTIARY,
        },
        include: {
          classTeachers: {
            include: {
              teacher: true,
            },
          },
          _count: {
            select: {
              enrollments: { where: enrollmentCountWhere },
            },
          },
        },
        orderBy: {
          name: 'asc',
        },
      });

      return classes.map((cls: any) =>
        this.mapToClassDto({ ...cls, studentsCount: cls._count?.enrollments ?? 0 }),
      );
    }

    // For PRIMARY/SECONDARY: Return ClassArms only
    const classArmWhere: any = {
      classLevel: {
        schoolId: school.id,
      },
      academicYear: targetAcademicYear,
      isActive: true,
    };

    if (typeFilter) {
      classArmWhere.classLevel = {
        ...classArmWhere.classLevel,
        type: typeFilter,
      };
    } else {
      // If no filter, get PRIMARY and SECONDARY ClassArms
      classArmWhere.classLevel = {
        ...classArmWhere.classLevel,
        type: { in: ['PRIMARY', 'SECONDARY'] },
      };
    }

    const classArms = await this.classArmModel.findMany({
      where: classArmWhere,
      include: {
        classLevel: true,
        classTeachers: {
          include: {
            teacher: true,
          },
        },
        _count: {
          select: {
            enrollments: { where: enrollmentCountWhere },
          },
        },
      },
      orderBy: [{ classLevel: { level: 'asc' } }, { name: 'asc' }],
    });

    return classArms.map((arm: any) =>
      this.mapToClassDto({
        id: arm.id,
        name: `${arm.classLevel.name} ${arm.name}`, // e.g., "JSS 3 A"
        code: null,
        classLevel: arm.classLevel.name,
        type: arm.classLevel.type,
        academicYear: arm.academicYear,
        description: null,
        isActive: arm.isActive,
        createdAt: arm.createdAt,
        updatedAt: arm.updatedAt,
        schoolId: school.id,
        studentsCount: arm._count?.enrollments ?? 0,
        teachers: (arm.classTeachers || []).map((ct: any) => ({
          id: ct.id,
          teacherId: ct.teacher.id,
          firstName: ct.teacher.firstName,
          lastName: ct.teacher.lastName,
          email: ct.teacher.email,
          subject: ct.subject || ct.teacher.subject,
          isPrimary: ct.isPrimary,
          isFormTeacher: !!ct.isFormTeacher,
          createdAt: ct.createdAt,
        })),
        classArmId: arm.id,
        classLevelId: arm.classLevelId,
      }),
    );
  }

  /**
   * Get a single class by ID (or ClassArm ID)
   * For PRIMARY/SECONDARY: If classId is ClassArm, returns ClassArm data
   * For TERTIARY: Returns Class data (backward compatibility)
   */
  async getClassById(schoolId: string, classId: string): Promise<ClassDto> {
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    // Check if classId is a ClassArm (for PRIMARY/SECONDARY schools using ClassArms)
    const classArm = await (this.prisma as any).classArm.findUnique({
      where: { id: classId },
      include: {
        classLevel: true,
        classTeachers: {
          include: {
            teacher: true,
          },
        },
      },
    });

    if (classArm && classArm.classLevel.schoolId === school.id) {
      // It's a ClassArm - return ClassArm data
      const studentsCount = await this.prisma.enrollment.count({
        where: {
          schoolId: school.id,
          classArmId: classArm.id,
          isActive: true,
          academicYear: classArm.academicYear,
        },
      });

      return this.mapToClassDto({
        id: classArm.id,
        name: `${classArm.classLevel.name} ${classArm.name}`,
        code: null,
        classLevel: classArm.classLevel.name,
        type: classArm.classLevel.type,
        academicYear: classArm.academicYear,
        description: null,
        isActive: classArm.isActive,
        createdAt: classArm.createdAt,
        updatedAt: classArm.updatedAt,
        schoolId: school.id,
        classTeachers: classArm.classTeachers,
        studentsCount,
        // Include ClassArm-specific IDs for curriculum and other features
        classArmId: classArm.id,
        classLevelId: classArm.classLevelId,
      });
    }

    // Fallback to Class (for schools without ClassArms or TERTIARY - backward compatibility)
    const classData = await this.classModel.findFirst({
      where: {
        id: classId,
        schoolId: school.id,
      },
      include: {
        classTeachers: {
          include: {
            teacher: true,
          },
        },
      },
    });

    if (!classData) {
      throw new NotFoundException('Class or ClassArm not found');
    }

    // Count enrollments that match by classId OR by classLevel and academicYear
    const studentsCount = await this.prisma.enrollment.count({
      where: {
        schoolId: school.id,
        isActive: true,
        academicYear: classData.academicYear,
        OR: [
          { classId: classData.id },
          {
            AND: [{ classId: null }, { classLevel: classData.classLevel }],
          },
        ],
      },
    });

    return this.mapToClassDto({
      ...classData,
      studentsCount,
    });
  }

  /**
   * Assign a teacher to a class or ClassArm
   * Supports both Classes (backward compatibility) and ClassArms (for PRIMARY/SECONDARY)
   */
  async assignTeacherToClass(
    schoolId: string,
    classId: string,
    assignmentData: AssignTeacherToClassDto
  ): Promise<ClassDto> {
    // Validate school exists
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    // Check if classId is a ClassArm (for PRIMARY/SECONDARY schools using ClassArms)
    const classArm = await (this.prisma as any).classArm.findUnique({
      where: { id: classId },
      include: {
        classLevel: true,
        classTeachers: {
          include: {
            teacher: true,
          },
        },
      },
    });

    let classData: any = null;
    let isClassArm = false;

    if (classArm && classArm.classLevel.schoolId === school.id) {
      // It's a ClassArm
      isClassArm = true;
      classData = {
        id: classArm.id,
        name: `${classArm.classLevel.name} ${classArm.name}`,
        type: classArm.classLevel.type,
        classLevel: classArm.classLevel.name,
        academicYear: classArm.academicYear,
        classTeachers: classArm.classTeachers,
      };
    } else {
      // It's a Class - validate it exists
      classData = await this.classModel.findFirst({
        where: {
          id: classId,
          schoolId: school.id,
        },
        include: {
          classTeachers: {
            include: {
              teacher: true,
            },
          },
        },
      });

      if (!classData) {
        throw new NotFoundException('Class or ClassArm not found');
      }
    }

    // Validate teacher exists in school
    const teacher = await this.staffRepository.findTeacherById(assignmentData.teacherId);
    if (!teacher || teacher.schoolId !== school.id) {
      throw new NotFoundException('Teacher not found in this school');
    }

    // Validate based on school type
    await this.validateTeacherAssignment(classData, teacher.id, assignmentData, isClassArm);

    // Check if assignment already exists
    const existingWhere: any = {
      teacherId: assignmentData.teacherId,
      subject: assignmentData.subject || null,
    };

    if (isClassArm) {
      existingWhere.classArmId = classId;
      existingWhere.classId = null;
    } else {
      existingWhere.classId = classId;
      existingWhere.classArmId = null;
    }

    const existingAssignment = await this.classTeacherModel.findFirst({
      where: existingWhere,
    });

    if (existingAssignment) {
      throw new ConflictException(
        'Teacher is already assigned to this class/arm with this subject'
      );
    }

    // For primary schools, if this is the primary teacher, unset other primary teachers
    if (classData.type === ClassType.PRIMARY && assignmentData.isPrimary) {
      const updateWhere: any = {
        isPrimary: true,
      };
      if (isClassArm) {
        updateWhere.classArmId = classId;
      } else {
        updateWhere.classId = classId;
      }

      await this.classTeacherModel.updateMany({
        where: updateWhere,
        data: {
          isPrimary: false,
        },
      });
    }

    // Create assignment
    const isSecondaryFormTeacher =
      classData.type === ClassType.SECONDARY && !!assignmentData.isPrimary;
    const assignmentDataToCreate: any = {
      teacherId: assignmentData.teacherId,
      subject: assignmentData.subject || null,
      isPrimary: assignmentData.isPrimary || false,
      isFormTeacher: isSecondaryFormTeacher,
    };

    if (isClassArm) {
      assignmentDataToCreate.classArmId = classId;
      assignmentDataToCreate.classId = null;
    } else {
      assignmentDataToCreate.classId = classId;
      assignmentDataToCreate.classArmId = null;
    }

    await this.classTeacherModel.create({
      data: assignmentDataToCreate,
    });

    // Send email to teacher if email exists
    const teacherEmail = (teacher as any).user?.email || teacher.email;
    if (teacherEmail && school) {
      try {
        await this.emailService.sendTeacherClassAssignmentEmail(
          teacherEmail,
          `${teacher.firstName} ${teacher.lastName}`,
          classData.name,
          classData.classLevel,
          assignmentData.subject || null,
          assignmentData.isPrimary || false,
          classData.type,
          school.name,
          classData.academicYear
        );
      } catch (error) {
        // Log error but don't fail the request
        console.error('Failed to send teacher class assignment email:', error);
      }
    } else if (!teacherEmail) {
      console.warn(
        `Teacher ${teacher.id} does not have an email address. Cannot send class assignment notification.`
      );
    }

    try {
      const userId = (teacher as any).userId;
      if (userId) {
        const className = classData.name;
        const subject = assignmentData.subject || null;
        const isPrimaryClass = !!assignmentData.isPrimary && !isSecondaryFormTeacher;
        const title = isSecondaryFormTeacher
          ? 'Form teacher assigned'
          : isPrimaryClass
            ? 'Class teacher assigned'
            : subject
              ? 'Subject assigned'
              : 'Class assigned';
        const subtitle = subject && !assignmentData.isPrimary ? `${subject}, ${className}` : className;
        const body = isSecondaryFormTeacher
          ? `You are now the form teacher of ${className}. You can follow reports and what is happening in that class.`
          : isPrimaryClass
            ? `You are now the class teacher of ${className}. You can follow reports and what is happening in that class.`
            : subject
              ? `You have been assigned to teach ${subject} in ${className}.`
              : `You have been assigned to ${className}.`;
        void this.notificationService.notifyUsers([userId], {
          schoolId,
          role: 'TEACHER',
          type: 'CLASS_ASSIGNED',
          title,
          subtitle,
          body,
          link: `/dashboard/teacher/classes/${classId}`,
          metadata: { classId, teacherId: teacher.id, subject },
        });
      }
    } catch {
      // Assignment must not be blocked by notification delivery.
    }

    // Return updated class
    return this.getClassById(schoolId, classId);
  }

  /**
   * Remove a teacher from a class or ClassArm
   * Supports both Classes (backward compatibility/TERTIARY) and ClassArms (for PRIMARY/SECONDARY)
   */
  async removeTeacherFromClass(
    schoolId: string,
    classId: string,
    teacherId: string,
    subject?: string
  ): Promise<void> {
    // Validate school exists
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    // Check if classId is a ClassArm (for PRIMARY/SECONDARY schools using ClassArms)
    const classArm = await (this.prisma as any).classArm.findUnique({
      where: { id: classId },
      include: {
        classLevel: true,
      },
    });

    let classData: any = null;
    let isClassArm = false;

    if (classArm && classArm.classLevel.schoolId === school.id) {
      // It's a ClassArm
      isClassArm = true;
      classData = {
        id: classArm.id,
        name: `${classArm.classLevel.name} ${classArm.name}`,
        classLevel: classArm.classLevel.name,
      };
    } else {
      // It's a Class - validate it exists (for TERTIARY/backward compatibility)
      classData = await this.classModel.findFirst({
        where: {
          id: classId,
          schoolId: school.id,
        },
      });

      if (!classData) {
        throw new NotFoundException('Class or ClassArm not found');
      }
    }

    // Build query based on whether it's ClassArm or Class
    const where: any = {
      teacherId: teacherId,
    };

    if (isClassArm) {
      where.classArmId = classId;
    } else {
      where.classId = classId;
    }

    if (subject) {
      where.subject = subject;
    }

    const assignment = await this.classTeacherModel.findFirst({
      where,
      include: {
        teacher: {
          include: {
            user: {
              select: {
                id: true,
                email: true,
              },
            },
          },
        },
      },
    });

    if (!assignment) {
      throw new NotFoundException('Teacher assignment not found');
    }

    // Get teacher email before deleting
    const teacherEmail = assignment.teacher?.user?.email || assignment.teacher?.email;

    await this.classTeacherModel.delete({
      where: {
        id: assignment.id,
      },
    });

    // Send email to teacher if email exists
    if (teacherEmail && school && assignment.teacher) {
      try {
        await this.emailService.sendTeacherClassRemovalEmail(
          teacherEmail,
          `${assignment.teacher.firstName} ${assignment.teacher.lastName}`,
          classData.name,
          classData.classLevel,
          assignment.subject || null,
          school.name
        );
      } catch (error) {
        // Log error but don't fail the request
        console.error('Failed to send teacher class removal email:', error);
      }
    }

    try {
      const userId = assignment.teacher?.user?.id;
      if (userId) {
        const className = classData.name;
        const subject = assignment.subject || null;
        void this.notificationService.notifyUsers([userId], {
          schoolId,
          role: 'TEACHER',
          type: 'CLASS_REMOVED',
          title: 'Removed from class',
          subtitle: subject ? `Removed from ${subject}, ${className}` : `Removed from ${className}`,
          body: subject
            ? `You no longer teach ${subject} in ${className}.`
            : `You have been removed from ${className}.`,
          link: '/dashboard/teacher/classes',
          metadata: { classId, teacherId: assignment.teacher.id, subject },
        });
      }
    } catch {
      // Removal must not be blocked by notification delivery.
    }
  }

  /**
   * Update a class or ClassArm
   * Supports both Classes (backward compatibility) and ClassArms (for PRIMARY/SECONDARY)
   */
  async updateClass(
    schoolId: string,
    classId: string,
    updateData: Partial<CreateClassDto>
  ): Promise<ClassDto> {
    // Validate school exists
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    // Check if classId is a ClassArm (for PRIMARY/SECONDARY schools using ClassArms)
    const classArm = await (this.prisma as any).classArm.findUnique({
      where: { id: classId },
      include: {
        classLevel: true,
        classTeachers: {
          include: {
            teacher: true,
          },
        },
      },
    });

    if (classArm && classArm.classLevel.schoolId === school.id) {
      // It's a ClassArm - update ClassArm name
      // For ClassArms, only the arm name (e.g., "A", "B", "Gold") can be updated
      // The full display name is constructed as "ClassLevel Name + Arm Name"
      const armUpdatePayload: any = {};

      if (updateData.name !== undefined) {
        // The name coming in might be the full display name (e.g., "Class 1 Gold")
        // or just the arm name (e.g., "Gold")
        // We need to extract just the arm name
        const classLevelName = classArm.classLevel.name;
        let newArmName = updateData.name;

        // If the name starts with the class level name, extract just the arm portion
        if (newArmName.startsWith(classLevelName + ' ')) {
          newArmName = newArmName.substring(classLevelName.length + 1).trim();
        }

        armUpdatePayload.name = newArmName || 'A'; // Default to 'A' if empty
      }

      if (Object.keys(armUpdatePayload).length === 0) {
        // Nothing to update, return current data
        const studentsCount = await this.prisma.enrollment.count({
          where: {
            schoolId: school.id,
            classArmId: classArm.id,
            isActive: true,
          },
        });
        return this.mapToClassDto({
          ...classArm,
          name: `${classArm.classLevel.name} ${classArm.name}`,
          classLevel: classArm.classLevel.name,
          type: classArm.classLevel.type,
          classArmId: classArm.id,
          classLevelId: classArm.classLevelId,
          studentsCount,
        });
      }

      const updatedArm = await (this.prisma as any).classArm.update({
        where: { id: classId },
        data: armUpdatePayload,
        include: {
          classLevel: true,
          classTeachers: {
            include: {
              teacher: true,
            },
          },
        },
      });

      const studentsCount = await this.prisma.enrollment.count({
        where: {
          schoolId: school.id,
          classArmId: updatedArm.id,
          isActive: true,
        },
      });

      return this.mapToClassDto({
        id: updatedArm.id,
        name: `${updatedArm.classLevel.name} ${updatedArm.name}`,
        code: null,
        classLevel: updatedArm.classLevel.name,
        type: updatedArm.classLevel.type,
        academicYear: updatedArm.academicYear,
        description: null,
        isActive: updatedArm.isActive,
        createdAt: updatedArm.createdAt,
        updatedAt: updatedArm.updatedAt,
        schoolId: school.id,
        studentsCount,
        teachers: (updatedArm.classTeachers || []).map((ct: any) => ({
          id: ct.id,
          teacherId: ct.teacher.id,
          firstName: ct.teacher.firstName,
          lastName: ct.teacher.lastName,
          email: ct.teacher.email,
          subject: ct.subject || ct.teacher.subject,
          isPrimary: ct.isPrimary,
          isFormTeacher: !!ct.isFormTeacher,
          createdAt: ct.createdAt,
        })),
        classArmId: updatedArm.id,
        classLevelId: updatedArm.classLevelId,
      });
    }

    // Fallback: It's a Class record - validate it exists
    const classData = await this.classModel.findFirst({
      where: {
        id: classId,
        schoolId: school.id,
      },
    });

    if (!classData) {
      throw new NotFoundException('Class or ClassArm not found');
    }

    // Validate school type if type is being updated
    if (updateData.type) {
      this.validateSchoolTypeForClass(school, updateData.type);
    }

    // Update class - allow renaming even if students are enrolled
    // This is safe because enrollments reference classId, not the name
    const updatePayload: any = {};
    if (updateData.name !== undefined) updatePayload.name = updateData.name;
    if (updateData.code !== undefined) updatePayload.code = updateData.code;
    if (updateData.classLevel !== undefined) updatePayload.classLevel = updateData.classLevel;
    if (updateData.type !== undefined) updatePayload.type = updateData.type;
    if (updateData.academicYear !== undefined) updatePayload.academicYear = updateData.academicYear;
    if (updateData.creditHours !== undefined) updatePayload.creditHours = updateData.creditHours;
    if (updateData.description !== undefined) updatePayload.description = updateData.description;

    const updated = await this.classModel.update({
      where: {
        id: classId,
      },
      data: updatePayload,
      include: {
        classTeachers: {
          include: {
            teacher: true,
          },
        },
        enrollments: {
          where: {
            isActive: true,
          },
        },
      },
    });

    return this.mapToClassDto(updated);
  }

  /**
   * Delete a class
   */
  /**
   * Delete a class or ClassArm
   * Supports both Classes (backward compatibility) and ClassArms (for PRIMARY/SECONDARY)
   * @param forceDelete - If true, will unenroll students and delete even if students are enrolled
   */
  async deleteClass(
    schoolId: string,
    classId: string,
    forceDelete: boolean = false
  ): Promise<void> {
    // Validate school exists
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    // Check if classId is a ClassArm (for PRIMARY/SECONDARY schools using ClassArms)
    const classArm = await (this.prisma as any).classArm.findUnique({
      where: { id: classId },
      include: {
        classLevel: true,
      },
    });

    if (classArm && classArm.classLevel.schoolId === school.id) {
      // It's a ClassArm - check for enrollments before deleting
      const enrollmentCount = await this.prisma.enrollment.count({
        where: {
          classArmId: classArm.id,
          isActive: true,
        },
      });

      if (enrollmentCount > 0 && !forceDelete) {
        throw new BadRequestException(
          `Cannot delete ClassArm "${classArm.classLevel.name} ${classArm.name}" because it has ${enrollmentCount} active student enrollment(s). Please transfer or remove students first, or use force delete.`
        );
      }

      // If force deleting, unenroll all students first
      if (enrollmentCount > 0 && forceDelete) {
        await this.prisma.enrollment.updateMany({
          where: {
            classArmId: classArm.id,
            isActive: true,
          },
          data: {
            isActive: false,
          },
        });
      }

      // Delete ClassArm
      await (this.prisma as any).classArm.delete({
        where: { id: classArm.id },
      });

      return;
    }

    // It's a Class - validate it exists
    const classData = await this.classModel.findFirst({
      where: {
        id: classId,
        schoolId: school.id,
      },
    });

    if (!classData) {
      throw new NotFoundException('Class or ClassArm not found');
    }

    // Check for enrollments before deleting (consistent with ClassArm behavior)
    const enrollmentCount = await this.prisma.enrollment.count({
      where: {
        classId: classId,
        isActive: true,
      },
    });

    if (enrollmentCount > 0 && !forceDelete) {
      throw new BadRequestException(
        `Cannot delete class "${classData.name}" because it has ${enrollmentCount} active student enrollment(s). Please transfer or remove students first, or use force delete.`
      );
    }

    // If force deleting, unenroll all students first
    if (enrollmentCount > 0 && forceDelete) {
      await this.prisma.enrollment.updateMany({
        where: {
          classId: classId,
          isActive: true,
        },
        data: {
          isActive: false,
        },
      });
    }

    // Also delete related class-teacher assignments first
    await this.classTeacherModel.deleteMany({
      where: {
        classId: classId,
      },
    });

    // Delete class
    await this.classModel.delete({
      where: {
        id: classId,
      },
    });
  }

  /**
   * Validate school type matches class type
   */
  private validateSchoolTypeForClass(school: any, classType: ClassType): void {
    if (classType === ClassType.PRIMARY && !school.hasPrimary) {
      throw new BadRequestException('School does not have primary level');
    }
    if (classType === ClassType.SECONDARY && !school.hasSecondary) {
      throw new BadRequestException('School does not have secondary level');
    }
    if (classType === ClassType.TERTIARY && !school.hasTertiary) {
      throw new BadRequestException('School does not have tertiary level');
    }
  }

  /**
   * Get students enrolled in a class
   */
  async getClassStudents(schoolId: string, classId: string): Promise<any[]> {
    // Validate school exists
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    // Check if classId is a ClassArm (for PRIMARY/SECONDARY schools using ClassArms)
    const classArm = await (this.prisma as any).classArm.findUnique({
      where: { id: classId },
      include: {
        classLevel: true,
      },
    });

    let enrollmentWhere: any;

    if (classArm && classArm.classLevel.schoolId === school.id) {
      // It's a ClassArm - get students enrolled in this arm
      enrollmentWhere = {
        schoolId: school.id,
        isActive: true,
        classArmId: classArm.id,
        academicYear: classArm.academicYear,
      };
    } else {
      // Fallback to Class (for schools without ClassArms or TERTIARY)
      const classData = await this.classModel.findFirst({
        where: {
          id: classId,
          schoolId: school.id,
        },
      });

      if (!classData) {
        throw new NotFoundException('Class not found');
      }

      // Get enrollments for this class
      // Students can be linked via classId OR by classLevel and academicYear
      enrollmentWhere = {
        schoolId: school.id,
        isActive: true,
        academicYear: classData.academicYear,
        OR: [
          { classId: classId },
          {
            AND: [{ classLevel: classData.classLevel }, { classId: null }],
          },
        ],
      };
    }

    const enrollments = await this.prisma.enrollment.findMany({
      where: enrollmentWhere,
      select: {
        id: true,
        termId: true,
        classLevel: true,
        academicYear: true,
        enrollmentDate: true,
        student: {
          select: {
            id: true,
            uid: true,
            publicId: true,
            firstName: true,
            lastName: true,
            middleName: true,
            dateOfBirth: true,
            profileImage: true,
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
      orderBy: [
        { createdAt: 'desc' },
        {
          student: {
            lastName: 'asc',
          },
        },
      ],
    });

    // Students may have multiple active enrollments for the same arm (per-term rows +
    // legacy termId=null). Class roster must be unique by student.
    const byStudent = new Map<string, (typeof enrollments)[number]>();
    for (const enrollment of enrollments) {
      const studentId = enrollment.student?.id;
      if (!studentId) continue;
      const existing = byStudent.get(studentId);
      if (!existing) {
        byStudent.set(studentId, enrollment);
        continue;
      }
      // Prefer an enrollment that is tied to a term over legacy null-term rows
      if (!existing.termId && enrollment.termId) {
        byStudent.set(studentId, enrollment);
        continue;
      }
      // Otherwise keep the newest (list is ordered by createdAt desc)
    }

    const uniqueEnrollments = Array.from(byStudent.values()).sort((a, b) => {
      const last = (a.student.lastName || '').localeCompare(b.student.lastName || '');
      if (last !== 0) return last;
      return (a.student.firstName || '').localeCompare(b.student.firstName || '');
    });

    return uniqueEnrollments.map((enrollment) => ({
      id: enrollment.student.id,
      uid: enrollment.student.uid,
      publicId: enrollment.student.publicId,
      firstName: enrollment.student.firstName,
      lastName: enrollment.student.lastName,
      middleName: enrollment.student.middleName,
      dateOfBirth: enrollment.student.dateOfBirth,
      profileImage: enrollment.student.profileImage,
      email: enrollment.student.user?.email || null,
      phone: enrollment.student.user?.phone || null,
      enrollment: {
        id: enrollment.id,
        classLevel: enrollment.classLevel,
        academicYear: enrollment.academicYear,
        enrollmentDate: enrollment.enrollmentDate,
      },
      user: enrollment.student.user,
    }));
  }

  /**
   * Validate teacher assignment based on school type
   */
  private async validateTeacherAssignment(
    classData: any,
    teacherId: string,
    assignmentData: AssignTeacherToClassDto,
    isClassArm = false,
  ): Promise<void> {
    // For primary schools: only one teacher allowed per class, and teacher can only be assigned to one class
    if (classData.type === ClassType.PRIMARY) {
      // Check if this teacher is already assigned to another PRIMARY class
      const teacherOtherAssignments = await this.classTeacherModel.findMany({
        where: {
          teacherId: teacherId,
        },
        include: {
          class: true,
        },
      });

      // Filter to only PRIMARY school classes
      const primaryClassAssignments = teacherOtherAssignments.filter(
        (assignment: any) =>
          assignment.class.type === ClassType.PRIMARY && assignment.class.id !== classData.id
      );

      if (primaryClassAssignments.length > 0) {
        const otherClass = primaryClassAssignments[0].class;
        throw new ConflictException(
          `This teacher is already assigned to ${otherClass.name}. Please remove them from that class before assigning to this class.`
        );
      }

      // Check if this class already has a teacher
      const existingTeachers = await this.classTeacherModel.findMany({
        where: {
          classId: classData.id,
        },
      });

      // If there's already a primary teacher and we're not setting this one as primary, reject
      const hasPrimaryTeacher = existingTeachers.some((t: any) => t.isPrimary);
      if (hasPrimaryTeacher && !assignmentData.isPrimary) {
        throw new BadRequestException(
          'Primary schools can only have one teacher per class. Set isPrimary to true to replace the current teacher.'
        );
      }

      // If subject is provided, it should be "Class Teacher" or similar
      if (
        assignmentData.subject &&
        !assignmentData.subject.toLowerCase().includes('class teacher')
      ) {
        // Allow it but warn - we'll accept it
      }
    }

    // For secondary schools:
    // - Form teachers (isPrimary: true) don't need a subject
    // - Subject teachers (isPrimary: false/undefined) require a subject
    if (classData.type === ClassType.SECONDARY) {
      // If this is a form teacher assignment (isPrimary: true), subject is optional
      if (assignmentData.isPrimary) {
        // Form teacher - no subject required. Arms store the row on classArmId.
        const existingFormTeacher = await this.classTeacherModel.findFirst({
          where: {
            ...(isClassArm ? { classArmId: classData.id } : { classId: classData.id }),
            OR: [{ isPrimary: true }, { isFormTeacher: true }],
          },
        });

        if (existingFormTeacher && existingFormTeacher.teacherId !== teacherId) {
          throw new ConflictException(
            'Another teacher is already assigned as the form teacher for this class'
          );
        }
      } else {
        // Subject teacher - subject is required
        if (!assignmentData.subject) {
          throw new BadRequestException(
            'Subject is required for subject teacher assignments in secondary schools'
          );
        }

        // Check if another teacher is already assigned to this subject
        const existingSubjectTeacher = await this.classTeacherModel.findFirst({
          where: {
            classId: classData.id,
            subject: assignmentData.subject,
          },
        });

        if (existingSubjectTeacher && existingSubjectTeacher.teacherId !== teacherId) {
          throw new ConflictException(
            `Another teacher is already assigned to teach ${assignmentData.subject} in this class`
          );
        }
      }
    }

    // For tertiary schools: subject is optional but recommended (can represent course module/topic)
    if (classData.type === ClassType.TERTIARY) {
      // Multiple teachers can teach the same course, each handling different modules/topics
      // No strict validation needed
    }
  }

  /**
   * Map Prisma class to DTO
   * Handles both:
   * - Raw Prisma objects with `classTeachers` relation
   * - Pre-mapped objects with `teachers` array (from ClassArm mapping)
   */
  private mapToClassDto(classData: any): ClassDto {
    // Check if teachers are already mapped (pre-processed from ClassArm)
    let teachers: any[] = [];

    if (classData.classTeachers && Array.isArray(classData.classTeachers)) {
      // Raw Prisma data with classTeachers relation
      teachers = classData.classTeachers.map((ct: any) => ({
        id: ct.id,
        teacherId: ct.teacher?.id || ct.teacherId,
        firstName: ct.teacher?.firstName || ct.firstName,
        lastName: ct.teacher?.lastName || ct.lastName,
        email: ct.teacher?.email || ct.email,
        subject: ct.subject,
        isPrimary: ct.isPrimary,
        isFormTeacher: ct.isFormTeacher || false,
        createdAt: ct.createdAt,
      }));
    } else if (classData.teachers && Array.isArray(classData.teachers)) {
      // Pre-mapped teachers array (from ClassArm processing)
      teachers = classData.teachers.map((t: any) => ({
        id: t.id,
        teacherId: t.teacherId || t.id, // teacherId may already be in the object
        firstName: t.firstName,
        lastName: t.lastName,
        email: t.email,
        subject: t.subject,
        isPrimary: t.isPrimary,
        isFormTeacher: t.isFormTeacher || false,
        createdAt: t.createdAt,
      }));
    }

    return {
      id: classData.id,
      name: classData.name,
      code: classData.code,
      classLevel: classData.classLevel,
      type: classData.type as ClassType,
      academicYear: classData.academicYear,
      creditHours: classData.creditHours,
      description: classData.description,
      isActive: classData.isActive,
      createdAt: classData.createdAt,
      teachers,
      studentsCount: classData.studentsCount ?? 0,
      // Include classArmId and classLevelId if present (for ClassArm-based classes)
      classArmId: classData.classArmId || undefined,
      classLevelId: classData.classLevelId || undefined,
    };
  }
}
