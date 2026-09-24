import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { SchoolRepository } from '../schools/domain/repositories/school.repository';
import { StaffRepository } from '../schools/domain/repositories/staff.repository';
import { UserWithContext } from '../auth/types/user-with-context.type';
import { CreateGradeDto, UpdateGradeDto } from './dto/grade.dto';
import { KnowledgeIndexingService } from '../ai/knowledge-indexing.service';
import { NotificationService } from '../notification/notification.service';
import { SchoolSettingsService } from '../school-settings/school-settings.service';

@Injectable()
export class GradesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly schoolRepository: SchoolRepository,
    private readonly staffRepository: StaffRepository,
    private readonly indexingService: KnowledgeIndexingService,
    private readonly notificationService: NotificationService,
    private readonly schoolSettingsService: SchoolSettingsService,
  ) {}

  /** JWT profileId is Teacher.id; legacy tokens may use Teacher.teacherId. */
  private async resolveTeacherProfile(profileId: string) {
    return (
      (await this.staffRepository.findTeacherById(profileId)) ??
      (await this.staffRepository.findTeacherByTeacherId(profileId))
    );
  }

  /**
   * Create a new grade
   */
  async createGrade(schoolId: string, dto: CreateGradeDto, user: UserWithContext): Promise<any> {
    const teacherId = user.currentProfileId;
    if (!teacherId) {
      throw new ForbiddenException('Teacher profile not found');
    }

    // Validate school exists
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new NotFoundException('School not found');
    }

    // Validate teacher exists and belongs to school
    // Note: currentProfileId contains teacherId (unique string), not the database id
    const teacher = await this.resolveTeacherProfile(teacherId);
    if (!teacher || teacher.schoolId !== school.id) {
      throw new ForbiddenException('Teacher not found in this school');
    }

    // Validate enrollment exists and belongs to school
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { id: dto.enrollmentId },
      include: {
        student: true,
        school: true,
      },
    });

    if (!enrollment) {
      throw new NotFoundException('Enrollment not found');
    }

    if (enrollment.schoolId !== school.id) {
      throw new ForbiddenException('Enrollment does not belong to this school');
    }

    if (!enrollment.isActive) {
      throw new BadRequestException('Cannot add grade to inactive enrollment');
    }

    // Validate score
    if (dto.score < 0 || dto.score > dto.maxScore) {
      throw new BadRequestException(`Score must be between 0 and ${dto.maxScore}`);
    }

    // Validate assessment date is not in the future
    let assessmentDate: Date | null = null;
    if (dto.assessmentDate) {
      assessmentDate = new Date(dto.assessmentDate);
      if (assessmentDate > new Date()) {
        throw new BadRequestException('Assessment date cannot be in the future');
      }
    }

    // Validate teacher is assigned to class/subject
    // Priority: subjectId (new) > subject string (legacy)
    let subjectId: string | null = null;
    let subjectName: string = dto.subject || '';

    if (dto.subjectId) {
      // NEW: Validate using subjectId (preferred method)
      const subject = await this.prisma.subject.findUnique({
        where: { id: dto.subjectId },
      });

      if (!subject) {
        throw new BadRequestException('Subject not found');
      }

      subjectId = subject.id;
      subjectName = subject.name; // Auto-populate subject string

      // Check if teacher is authorized to grade this subject for this class
      const classId = enrollment.classArmId || enrollment.classId;

      // Check 1: Is teacher a primary/class teacher? (can grade all subjects for PRIMARY)
      const isPrimaryTeacher = await this.prisma.classTeacher.findFirst({
        where: {
          teacherId: teacher.id,
          isPrimary: true,
          ...(enrollment.classArmId
            ? { classArmId: enrollment.classArmId }
            : { classId: enrollment.classId }),
        },
      });

      if (!isPrimaryTeacher) {
        // Check 2: Is teacher assigned to this specific subject via ClassTeacher?
        const subjectAssignment = await this.prisma.classTeacher.findFirst({
          where: {
            teacherId: teacher.id,
            subjectId: dto.subjectId,
            ...(enrollment.classArmId
              ? { classArmId: enrollment.classArmId }
              : { classId: enrollment.classId }),
          },
        });

        if (!subjectAssignment) {
          // Check 3: Is teacher assigned via timetable?
          const timetableAssignment = await this.prisma.timetablePeriod.findFirst({
            where: {
              teacherId: teacher.id,
              subjectId: dto.subjectId,
              ...(enrollment.classArmId
                ? { classArmId: enrollment.classArmId }
                : { classId: enrollment.classId }),
            },
          });

          if (!timetableAssignment) {
            throw new ForbiddenException(
              'You are not authorized to grade this subject for this class'
            );
          }
        }
      }
    } else if (dto.subject) {
      // LEGACY: Validate using subject string (for backward compatibility)
      const classAssignmentWhere: any = {
        teacherId: teacher.id,
        subject: dto.subject,
      };

      if (enrollment.classArmId) {
        classAssignmentWhere.classArmId = enrollment.classArmId;
      } else if (enrollment.classId) {
        classAssignmentWhere.classId = enrollment.classId;
      }

      const classAssignment = await this.prisma.classTeacher.findFirst({
        where: classAssignmentWhere,
      });

      if (!classAssignment) {
        // Check if teacher is primary teacher (for primary schools)
        const primaryTeacherWhere: any = {
          teacherId: teacher.id,
          isPrimary: true,
        };

        if (enrollment.classArmId) {
          primaryTeacherWhere.classArmId = enrollment.classArmId;
        } else if (enrollment.classId) {
          primaryTeacherWhere.classId = enrollment.classId;
        }

        const isPrimaryTeacher = await this.prisma.classTeacher.findFirst({
          where: primaryTeacherWhere,
        });

        if (!isPrimaryTeacher) {
          throw new ForbiddenException('You are not assigned to teach this subject in this class');
        }
      }

      // Try to find matching Subject entity for the string
      const matchingSubject = await this.prisma.subject.findFirst({
        where: {
          schoolId: school.id,
          name: { equals: dto.subject, mode: 'insensitive' },
          isActive: true,
        },
      });

      if (matchingSubject) {
        subjectId = matchingSubject.id;
      }
    }

    // Get term info if termId provided
    let termName = dto.term;
    let academicYear = dto.academicYear || enrollment.academicYear;

    if (dto.termId) {
      const term = await this.prisma.term.findUnique({
        where: { id: dto.termId },
        include: { academicSession: true },
      });

      if (term) {
        termName = term.name;
        academicYear = term.academicSession?.name || academicYear; // Use session name, not academicYear property
      }
    }

    // Ensure termName is defined
    if (!termName) {
      throw new BadRequestException('Term name is required. Please provide termId or ensure term exists.');
    }

    // Create grade
    // Note: Use teacher.id (database ID) for Grade.teacherId
    const grade = await this.prisma.grade.create({
      data: {
        enrollmentId: dto.enrollmentId,
        teacherId: teacher.id,
        subjectId: subjectId, // NEW: Link to Subject entity
        subject: subjectName, // Auto-populated from Subject if subjectId provided
        gradeType: dto.gradeType,
        assessmentName: dto.assessmentName || null,
        assessmentDate: assessmentDate,
        sequence: dto.sequence || null,
        score: dto.score,
        maxScore: dto.maxScore,
        term: termName,
        academicYear: academicYear,
        termId: dto.termId || null,
        remarks: dto.remarks || null,
        isPublished: dto.isPublished || false,
        signedAt: new Date(),
      },
      include: {
        enrollment: {
          include: {
            student: {
              include: {
                user: {
                  select: {
                    id: true,
                    email: true,
                    phone: true,
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
    });

    // Automated Indexing: Keep the AI knowledge base updated with the latest performance
    this.indexingService.triggerEntitySync('student', grade.enrollment.studentId).catch((err: Error) => 
      console.error(`[AI Indexing] Failed to update student ${grade.enrollment.studentId}:`, err)
    );
    if (grade.isPublished) {
      try {
        void this.notificationService.emitGradePublished({
          schoolId,
          studentId: grade.enrollment.studentId,
          assessmentTitle: grade.assessmentName || grade.gradeType,
          subjectName: grade.subject,
          score: grade.score.toNumber(),
          maxScore: grade.maxScore.toNumber(),
          timestamp: new Date().toISOString(),
        });
      } catch {
        // Grade creation must not depend on notification delivery.
      }
    }

    return {
      id: grade.id,
      enrollmentId: grade.enrollmentId,
      teacherId: grade.teacherId,
      subject: grade.subject,
      gradeType: grade.gradeType,
      assessmentName: grade.assessmentName,
      assessmentDate: grade.assessmentDate,
      sequence: grade.sequence,
      score: grade.score.toNumber(),
      maxScore: grade.maxScore.toNumber(),
      term: grade.term,
      academicYear: grade.academicYear,
      remarks: grade.remarks,
      isPublished: grade.isPublished,
      signedAt: grade.signedAt,
      createdAt: grade.createdAt,
      student: {
        id: grade.enrollment.student.id,
        firstName: grade.enrollment.student.firstName,
        lastName: grade.enrollment.student.lastName,
        uid: grade.enrollment.student.uid,
      },
      teacher: grade.teacher,
    };
  }

  /**
   * Update a grade
   */
  async updateGrade(
    schoolId: string,
    gradeId: string,
    dto: UpdateGradeDto,
    user: UserWithContext
  ): Promise<any> {
    const teacherProfileId = user.currentProfileId;
    if (!teacherProfileId) {
      throw new ForbiddenException('Teacher profile not found');
    }

    // Validate school exists
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new NotFoundException('School not found');
    }

    // Get teacher's database ID from profile ID
    // Note: currentProfileId contains teacherId (unique string like "TCH-XXX"), not the database id
    const teacher = await this.resolveTeacherProfile(teacherProfileId);
    if (!teacher || teacher.schoolId !== school.id) {
      throw new ForbiddenException('Teacher not found in this school');
    }

    // Get grade
    const grade = await this.prisma.grade.findUnique({
      where: { id: gradeId },
      include: {
        enrollment: {
          include: {
            school: true,
          },
        },
        teacher: true,
      },
    });

    if (!grade) {
      throw new NotFoundException('Grade not found');
    }

    if (grade.enrollment.schoolId !== school.id) {
      throw new ForbiddenException('Grade does not belong to this school');
    }

    // Only the teacher who created the grade can update it
    // Compare using database ID (teacher.id) or profile ID (for backward compatibility with old grades)
    const isOwner = grade.teacherId === teacher.id || grade.teacherId === teacherProfileId;
    if (!isOwner) {
      throw new ForbiddenException('You can only update grades you created');
    }

    const gradingPolicy = await this.schoolSettingsService.getGradingPolicy(school.id);
    if (grade.termId) {
      const term = await this.prisma.term.findUnique({ where: { id: grade.termId } });
      if (term?.endDate) {
        const lockDate = new Date(term.endDate);
        lockDate.setDate(lockDate.getDate() + (gradingPolicy.gradeLockDaysAfterTermEnd ?? 7));
        if (new Date() > lockDate && (dto.score !== undefined || dto.isPublished !== undefined)) {
          throw new BadRequestException('Grading period is locked for this term.');
        }
      }
    }

    if (dto.isPublished && gradingPolicy.gradeApprovalRequired && !grade.isPublished) {
      throw new BadRequestException('Grade approval is required before publishing. Contact your administrator.');
    }

    // Validate score if provided
    const newScore = dto.score !== undefined ? dto.score : grade.score.toNumber();
    const newMaxScore = dto.maxScore !== undefined ? dto.maxScore : grade.maxScore.toNumber();

    if (newScore < 0 || newScore > newMaxScore) {
      throw new BadRequestException(`Score must be between 0 and ${newMaxScore}`);
    }

    // Validate assessment date if provided
    let assessmentDate: Date | null = null;
    if (dto.assessmentDate !== undefined) {
      if (dto.assessmentDate) {
        assessmentDate = new Date(dto.assessmentDate);
        if (assessmentDate > new Date()) {
          throw new BadRequestException('Assessment date cannot be in the future');
        }
      } else {
        assessmentDate = null;
      }
    }

    // Update grade
    const updatedGrade = await this.prisma.grade.update({
      where: { id: gradeId },
      data: {
        ...(dto.score !== undefined && { score: dto.score }),
        ...(dto.maxScore !== undefined && { maxScore: dto.maxScore }),
        ...(dto.remarks !== undefined && { remarks: dto.remarks }),
        ...(dto.subject !== undefined && { subject: dto.subject }),
        ...(dto.assessmentName !== undefined && { assessmentName: dto.assessmentName }),
        ...(assessmentDate !== undefined && { assessmentDate }),
        ...(dto.sequence !== undefined && { sequence: dto.sequence }),
        ...(dto.isPublished !== undefined && { isPublished: dto.isPublished }),
      },
      include: {
        enrollment: {
          include: {
            student: {
              include: {
                user: {
                  select: {
                    id: true,
                    email: true,
                    phone: true,
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
    });

    // Automated Indexing: Sync the updated performance to the knowledge base
    this.indexingService.triggerEntitySync('student', updatedGrade.enrollment.studentId).catch((err: Error) => 
      console.error(`[AI Indexing] Failed to update student ${updatedGrade.enrollment.studentId}:`, err)
    );
    if (!grade.isPublished && updatedGrade.isPublished) {
      try {
        void this.notificationService.emitGradePublished({
          schoolId,
          studentId: updatedGrade.enrollment.studentId,
          assessmentTitle: updatedGrade.assessmentName || updatedGrade.gradeType,
          subjectName: updatedGrade.subject,
          score: updatedGrade.score.toNumber(),
          maxScore: updatedGrade.maxScore.toNumber(),
          timestamp: new Date().toISOString(),
        });
      } catch {
        // Grade publishing must not depend on notification delivery.
      }
    }

    return {
      id: updatedGrade.id,
      enrollmentId: updatedGrade.enrollmentId,
      teacherId: updatedGrade.teacherId,
      subject: updatedGrade.subject,
      gradeType: updatedGrade.gradeType,
      assessmentName: updatedGrade.assessmentName,
      assessmentDate: updatedGrade.assessmentDate,
      sequence: updatedGrade.sequence,
      score: updatedGrade.score.toNumber(),
      maxScore: updatedGrade.maxScore.toNumber(),
      term: updatedGrade.term,
      academicYear: updatedGrade.academicYear,
      remarks: updatedGrade.remarks,
      isPublished: updatedGrade.isPublished,
      signedAt: updatedGrade.signedAt,
      createdAt: updatedGrade.createdAt,
      student: {
        id: updatedGrade.enrollment.student.id,
        firstName: updatedGrade.enrollment.student.firstName,
        lastName: updatedGrade.enrollment.student.lastName,
        uid: updatedGrade.enrollment.student.uid,
      },
      teacher: updatedGrade.teacher,
    };
  }

  /**
   * Delete a grade
   */
  async deleteGrade(schoolId: string, gradeId: string, user: UserWithContext): Promise<void> {
    const teacherProfileId = user.currentProfileId;
    if (!teacherProfileId) {
      throw new ForbiddenException('Teacher profile not found');
    }

    // Validate school exists
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new NotFoundException('School not found');
    }

    // Get teacher's database ID from profile ID
    // Note: currentProfileId contains teacherId (unique string like "TCH-XXX"), not the database id
    const teacher = await this.resolveTeacherProfile(teacherProfileId);
    if (!teacher || teacher.schoolId !== school.id) {
      throw new ForbiddenException('Teacher not found in this school');
    }

    // Get grade
    const grade = await this.prisma.grade.findUnique({
      where: { id: gradeId },
      include: {
        enrollment: {
          include: {
            school: true,
          },
        },
      },
    });

    if (!grade) {
      throw new NotFoundException('Grade not found');
    }

    if (grade.enrollment.schoolId !== school.id) {
      throw new ForbiddenException('Grade does not belong to this school');
    }

    // Only the teacher who created the grade can delete it
    // Compare using database ID (teacher.id) or profile ID (for backward compatibility with old grades)
    const isOwner = grade.teacherId === teacher.id || grade.teacherId === teacherProfileId;
    if (!isOwner) {
      throw new ForbiddenException('You can only delete grades you created');
    }

    await this.prisma.grade.delete({
      where: { id: gradeId },
    });

    // Automated Indexing: Refresh student data after grade removal
    this.indexingService.triggerEntitySync('student', grade.enrollment.studentId).catch((err: Error) => 
      console.error(`[AI Indexing] Failed to update student ${grade.enrollment.studentId}:`, err)
    );
  }

  /**
   * Get grades for a class or ClassArm
   * Supports both Classes (TERTIARY/backward compat) and ClassArms (PRIMARY/SECONDARY)
   */
  async getClassGrades(
    schoolId: string,
    classId: string,
    subject?: string,
    termId?: string,
    gradeType?: string,
    user?: UserWithContext
  ): Promise<any[]> {
    // Validate school exists
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new NotFoundException('School not found');
    }

    // Check if classId is a ClassArm (for PRIMARY/SECONDARY schools)
    const classArm = await this.prisma.classArm.findUnique({
      where: { id: classId },
      include: { classLevel: true },
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
        academicYear: classArm.academicYear,
        type: classArm.classLevel.type,
      };
    } else {
      // It's a Class - validate it exists (for TERTIARY/backward compatibility)
      classData = await this.prisma.class.findFirst({
        where: {
          id: classId,
          schoolId: school.id,
        },
      });

      if (!classData) {
        throw new NotFoundException('Class or ClassArm not found');
      }
    }

    // Get enrollments for this class/ClassArm
    const enrollmentWhere: any = {
      schoolId: school.id,
      isActive: true,
      academicYear: classData.academicYear,
    };

    if (isClassArm) {
      enrollmentWhere.classArmId = classId;
    } else {
      enrollmentWhere.OR = [
        { classId: classId },
        {
          AND: [{ classLevel: classData.classLevel }, { classId: null }],
        },
      ];
    }

    const enrollments = await this.prisma.enrollment.findMany({
      where: enrollmentWhere,
      select: { id: true },
    });

    const enrollmentIds = enrollments.map((e) => e.id);

    // Build where clause for grades
    const where: any = {
      enrollmentId: { in: enrollmentIds },
    };

    // Filter by subject if provided
    if (subject) {
      where.subject = subject;
    }

    // Filter by term if provided
    if (termId) {
      where.termId = termId;
    }

    // Filter by grade type if provided
    if (gradeType) {
      where.gradeType = gradeType;
    }

    // If teacher context provided, filter by teacher's subjects
    if (user?.currentProfileId) {
      // Note: currentProfileId contains teacherId (unique string), not the database id
      const teacherIdString = user.currentProfileId;
      const teacher = await this.resolveTeacherProfile(teacherIdString);

      if (teacher) {
        // Get teacher's assigned subjects for this class/ClassArm
        // Use teacher.id (database ID) for ClassTeacher.teacherId
        const assignmentWhere: any = {
          teacherId: teacher.id,
        };

        if (isClassArm) {
          assignmentWhere.classArmId = classId;
        } else {
          assignmentWhere.classId = classId;
        }

        const assignments = await this.prisma.classTeacher.findMany({
          where: assignmentWhere,
        });

        if (assignments.length > 0) {
          // If teacher has specific subject assignments, only show those subjects
          const assignedSubjects = assignments.map((a) => a.subject).filter(Boolean);
          if (assignedSubjects.length > 0 && !subject) {
            where.subject = { in: assignedSubjects };
          }
        }

        // Also filter by teacherId to only show grades entered by this teacher
        // Use teacher.id (database ID) for Grade.teacherId
        where.teacherId = teacher.id;
      }
    }

    // Get grades
    const grades = await this.prisma.grade.findMany({
      where,
      include: {
        enrollment: {
          include: {
            student: {
              include: {
                user: {
                  select: {
                    id: true,
                    email: true,
                    phone: true,
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

    return grades.map((grade) => ({
      id: grade.id,
      enrollmentId: grade.enrollmentId,
      teacherId: grade.teacherId,
      subject: grade.subject,
      gradeType: grade.gradeType,
      assessmentName: grade.assessmentName,
      assessmentDate: grade.assessmentDate,
      sequence: grade.sequence,
      score: grade.score.toNumber(),
      maxScore: grade.maxScore.toNumber(),
      term: grade.term,
      academicYear: grade.academicYear,
      remarks: grade.remarks,
      isPublished: grade.isPublished,
      signedAt: grade.signedAt,
      createdAt: grade.createdAt,
      updatedAt: grade.updatedAt,
      student: {
        id: grade.enrollment.student.id,
        firstName: grade.enrollment.student.firstName,
        lastName: grade.enrollment.student.lastName,
        uid: grade.enrollment.student.uid,
        publicId: grade.enrollment.student.publicId,
      },
      teacher: grade.teacher,
    }));
  }

  /**
   * Get grades for a student
   */
  async getStudentGrades(
    schoolId: string,
    studentId: string,
    subject?: string,
    user?: UserWithContext
  ): Promise<any[]> {
    // Validate school exists
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new NotFoundException('School not found');
    }

    // Validate student exists
    const student = await this.prisma.student.findUnique({
      where: { id: studentId },
      include: {
        enrollments: {
          where: {
            schoolId: school.id,
            isActive: true,
          },
        },
      },
    });

    if (!student) {
      throw new NotFoundException('Student not found');
    }

    if (student.enrollments.length === 0) {
      throw new BadRequestException('Student is not enrolled in this school');
    }

    const enrollmentIds = student.enrollments.map((e) => e.id);

    // Build where clause
    const where: any = {
      enrollmentId: { in: enrollmentIds },
    };

    if (subject) {
      where.subject = subject;
    }

    // If teacher context provided, filter by teacher's subjects
    if (user?.currentProfileId) {
      // Note: currentProfileId contains teacherId (unique string), not the database id
      const teacherIdString = user.currentProfileId;
      const teacher = await this.resolveTeacherProfile(teacherIdString);

      if (teacher) {
        // Use teacher.id (database ID) for Grade.teacherId
        where.teacherId = teacher.id;

        if (!subject) {
          // Get teacher's subjects from their class assignments (both Class and ClassArm)
          // Use teacher.id (database ID) for ClassTeacher.teacherId
          const classAssignments = await this.prisma.classTeacher.findMany({
            where: {
              teacherId: teacher.id,
              classId: { not: null },
              class: {
                schoolId: school.id,
              },
            },
            select: { subject: true },
          });

          const classArmAssignments = await this.prisma.classTeacher.findMany({
            where: {
              teacherId: teacher.id,
              classArmId: { not: null },
              classArm: {
                classLevel: {
                  schoolId: school.id,
                },
              },
            },
            select: { subject: true },
          });

          const allAssignments = [...classAssignments, ...classArmAssignments];
          const assignedSubjects = allAssignments.map((a) => a.subject).filter(Boolean);
          if (assignedSubjects.length > 0) {
            where.subject = { in: assignedSubjects };
          }
        }
      }
    }

    // Get grades
    const grades = await this.prisma.grade.findMany({
      where,
      include: {
        enrollment: {
          include: {
            student: {
              include: {
                user: {
                  select: {
                    id: true,
                    email: true,
                    phone: true,
                  },
                },
              },
            },
            school: {
              select: {
                id: true,
                name: true,
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

    return grades.map((grade) => ({
      id: grade.id,
      enrollmentId: grade.enrollmentId,
      teacherId: grade.teacherId,
      subject: grade.subject,
      gradeType: grade.gradeType,
      assessmentName: grade.assessmentName,
      assessmentDate: grade.assessmentDate,
      sequence: grade.sequence,
      score: grade.score.toNumber(),
      maxScore: grade.maxScore.toNumber(),
      term: grade.term,
      academicYear: grade.academicYear,
      remarks: grade.remarks,
      isPublished: grade.isPublished,
      signedAt: grade.signedAt,
      createdAt: grade.createdAt,
      updatedAt: grade.updatedAt,
      percentage:
        grade.maxScore.toNumber() > 0
          ? (grade.score.toNumber() / grade.maxScore.toNumber()) * 100
          : 0,
      enrollment: {
        id: grade.enrollment.id,
        classLevel: grade.enrollment.classLevel,
        academicYear: grade.enrollment.academicYear,
      },
      student: {
        id: grade.enrollment.student.id,
        firstName: grade.enrollment.student.firstName,
        lastName: grade.enrollment.student.lastName,
        uid: grade.enrollment.student.uid,
        publicId: grade.enrollment.student.publicId,
      },
      teacher: grade.teacher,
    }));
  }

  /**
   * Bulk create grades for a class or ClassArm
   * Supports both Classes (TERTIARY/backward compat) and ClassArms (PRIMARY/SECONDARY)
   */
  async bulkCreateGrades(schoolId: string, dto: any, user: UserWithContext): Promise<any[]> {
    const teacherId = user.currentProfileId;
    if (!teacherId) {
      throw new ForbiddenException('Teacher profile not found');
    }

    // Validate school exists
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new NotFoundException('School not found');
    }

    // Validate teacher exists and belongs to school
    // Note: currentProfileId contains teacherId (unique string), not the database id
    const teacher = await this.resolveTeacherProfile(teacherId);
    if (!teacher || teacher.schoolId !== school.id) {
      throw new ForbiddenException('Teacher not found in this school');
    }

    // Check if classId is a ClassArm (for PRIMARY/SECONDARY schools)
    const classArm = await this.prisma.classArm.findUnique({
      where: { id: dto.classId },
      include: { classLevel: true },
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
        academicYear: classArm.academicYear,
        type: classArm.classLevel.type,
      };
    } else {
      // It's a Class - validate it exists (for TERTIARY/backward compatibility)
      classData = await this.prisma.class.findFirst({
        where: {
          id: dto.classId,
          schoolId: school.id,
        },
      });

      if (!classData) {
        throw new NotFoundException('Class or ClassArm not found');
      }
    }

    // Validate teacher is assigned to this class/ClassArm/subject
    // Priority: subjectId (new) > subject string (legacy)
    let subjectId: string | null = null;
    let subjectName: string = dto.subject || '';

    if (dto.subjectId) {
      // NEW: Validate using subjectId (preferred method)
      const subject = await this.prisma.subject.findUnique({
        where: { id: dto.subjectId },
      });

      if (!subject) {
        throw new BadRequestException('Subject not found');
      }

      subjectId = subject.id;
      subjectName = subject.name;

      // Check if teacher is authorized
      const primaryWhere: any = {
        teacherId: teacher.id,
        isPrimary: true,
      };
      if (isClassArm) {
        primaryWhere.classArmId = dto.classId;
      } else {
        primaryWhere.classId = dto.classId;
      }

      const isPrimaryTeacher = await this.prisma.classTeacher.findFirst({
        where: primaryWhere,
      });

      if (!isPrimaryTeacher) {
        // Check subject assignment
        const subjectAssignment = await this.prisma.classTeacher.findFirst({
          where: {
            teacherId: teacher.id,
            subjectId: dto.subjectId,
            ...(isClassArm ? { classArmId: dto.classId } : { classId: dto.classId }),
          },
        });

        if (!subjectAssignment) {
          // Check timetable assignment
          const timetableAssignment = await this.prisma.timetablePeriod.findFirst({
            where: {
              teacherId: teacher.id,
              subjectId: dto.subjectId,
              ...(isClassArm ? { classArmId: dto.classId } : { classId: dto.classId }),
            },
          });

          if (!timetableAssignment) {
            throw new ForbiddenException(
              'You are not authorized to grade this subject for this class'
            );
          }
        }
      }
    } else if (dto.subject) {
      // LEGACY: Validate using subject string
      const assignmentWhere: any = {
        teacherId: teacher.id,
        subject: dto.subject,
      };

      if (isClassArm) {
        assignmentWhere.classArmId = dto.classId;
      } else {
        assignmentWhere.classId = dto.classId;
      }

      const assignment = await this.prisma.classTeacher.findFirst({
        where: assignmentWhere,
      });

      if (!assignment) {
        const primaryWhere: any = {
          teacherId: teacher.id,
          isPrimary: true,
        };

        if (isClassArm) {
          primaryWhere.classArmId = dto.classId;
        } else {
          primaryWhere.classId = dto.classId;
        }

        const isPrimaryTeacher = await this.prisma.classTeacher.findFirst({
          where: primaryWhere,
        });

        if (!isPrimaryTeacher) {
          throw new ForbiddenException('You are not assigned to teach this subject in this class');
        }
      }

      // Try to find matching Subject entity
      const matchingSubject = await this.prisma.subject.findFirst({
        where: {
          schoolId: school.id,
          name: { equals: dto.subject, mode: 'insensitive' },
          isActive: true,
        },
      });

      if (matchingSubject) {
        subjectId = matchingSubject.id;
      }
    } else {
      // No subject specified - check if teacher is assigned to class
      const assignmentWhere: any = {
        teacherId: teacher.id,
      };

      if (isClassArm) {
        assignmentWhere.classArmId = dto.classId;
      } else {
        assignmentWhere.classId = dto.classId;
      }

      const assignment = await this.prisma.classTeacher.findFirst({
        where: assignmentWhere,
      });

      if (!assignment) {
        throw new ForbiddenException('You are not assigned to this class');
      }
    }

    // Get term info if termId provided
    let termName = '';
    let academicYear = classData.academicYear;

    if (dto.termId) {
      const term = await this.prisma.term.findUnique({
        where: { id: dto.termId },
        include: { academicSession: true },
      });

      if (term) {
        termName = term.name;
        // AcademicSession doesn't have academicYear field, use name instead
        academicYear = term.academicSession?.name || academicYear;
      }
    }

    // Validate assessment date
    let assessmentDate: Date | null = null;
    if (dto.assessmentDate) {
      assessmentDate = new Date(dto.assessmentDate);
      if (assessmentDate > new Date()) {
        throw new BadRequestException('Assessment date cannot be in the future');
      }
    }

    // Validate all enrollments exist and belong to school
    const enrollmentIds = dto.grades.map((g: any) => g.enrollmentId);
    const enrollments = await this.prisma.enrollment.findMany({
      where: {
        id: { in: enrollmentIds },
        schoolId: school.id,
        isActive: true,
      },
    });

    if (enrollments.length !== enrollmentIds.length) {
      throw new BadRequestException('Some enrollments are invalid or inactive');
    }

    // Validate all scores
    for (const gradeEntry of dto.grades) {
      if (gradeEntry.score < 0 || gradeEntry.score > dto.maxScore) {
        throw new BadRequestException(
          `Score must be between 0 and ${dto.maxScore} for enrollment ${gradeEntry.enrollmentId}`
        );
      }
    }

    // Create grades in bulk
    // Note: Use teacher.id (database ID) for Grade.teacherId
    const grades = await Promise.all(
      dto.grades.map((gradeEntry: any) =>
        this.prisma.grade.create({
          data: {
            enrollmentId: gradeEntry.enrollmentId,
            teacherId: teacher.id,
            subjectId: subjectId, // NEW: Link to Subject entity
            subject: subjectName, // Auto-populated from Subject if subjectId provided
            gradeType: dto.gradeType,
            assessmentName: dto.assessmentName,
            assessmentDate: assessmentDate,
            sequence: dto.sequence || null,
            score: gradeEntry.score,
            maxScore: dto.maxScore,
            term: termName,
            academicYear: dto.academicYear || academicYear,
            termId: dto.termId || null,
            remarks: gradeEntry.remarks || null,
            isPublished: dto.isPublished || false,
            signedAt: new Date(),
          },
          include: {
            enrollment: {
              include: {
                student: {
                  include: {
                    user: {
                      select: {
                        id: true,
                        email: true,
                        phone: true,
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
        })
      )
    );

    return grades.map((grade) => ({
      id: grade.id,
      enrollmentId: grade.enrollmentId,
      teacherId: grade.teacherId,
      subject: grade.subject,
      gradeType: grade.gradeType,
      assessmentName: grade.assessmentName,
      assessmentDate: grade.assessmentDate,
      sequence: grade.sequence,
      score: grade.score.toNumber(),
      maxScore: grade.maxScore.toNumber(),
      term: grade.term,
      academicYear: grade.academicYear,
      remarks: grade.remarks,
      isPublished: grade.isPublished,
      signedAt: grade.signedAt,
      createdAt: grade.createdAt,
      student: {
        id: grade.enrollment.student.id,
        firstName: grade.enrollment.student.firstName,
        lastName: grade.enrollment.student.lastName,
        uid: grade.enrollment.student.uid,
      },
      teacher: grade.teacher,
    }));
  }

  /**
   * Get grades for a class grouped by students
   * Returns student-centric data with aggregated metrics
   */
  async getClassGradesGroupedByStudents(
    schoolId: string,
    classId: string,
    subject?: string,
    termId?: string,
    gradeType?: string,
    user?: UserWithContext,
    classReport = false
  ): Promise<any[]> {
    // Validate school exists
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new NotFoundException('School not found');
    }

    // Check if classId is a ClassArm (for PRIMARY/SECONDARY schools)
    const classArm = await this.prisma.classArm.findUnique({
      where: { id: classId },
      include: { classLevel: true },
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
        academicYear: classArm.academicYear,
        type: classArm.classLevel.type,
      };
    } else {
      // It's a Class - validate it exists (for TERTIARY/backward compatibility)
      classData = await this.prisma.class.findFirst({
        where: {
          id: classId,
          schoolId: school.id,
        },
      });

      if (!classData) {
        throw new NotFoundException('Class or ClassArm not found');
      }
    }

    // Get enrollments for this class/ClassArm
    const enrollmentWhere: any = {
      schoolId: school.id,
      isActive: true,
      academicYear: classData.academicYear,
    };

    if (isClassArm) {
      enrollmentWhere.classArmId = classId;
    } else {
      enrollmentWhere.OR = [
        { classId: classId },
        {
          AND: [{ classLevel: classData.classLevel }, { classId: null }],
        },
      ];
    }

    const enrollments = await this.prisma.enrollment.findMany({
      where: enrollmentWhere,
      include: {
        student: true,
      },
    });

    // Get all grades for this class
    const enrollmentIds = enrollments.map((e) => e.id);

    // Build where clause for grades
    const where: any = {
      enrollmentId: { in: enrollmentIds },
    };

    // Apply filters
    if (subject) {
      where.subject = subject;
    }
    if (termId) {
      where.termId = termId;
    }
    if (gradeType) {
      where.gradeType = gradeType;
    }

    // A form teacher reading the class report sees every published grade.
    // Subject teachers still see only the grades they entered.
    let classWideReport = false;
    if (user?.currentProfileId) {
      const teacherIdString = user.currentProfileId;
      const teacher = await this.resolveTeacherProfile(teacherIdString);

      if (teacher) {
        if (classReport) {
          const formAssignment = await this.prisma.classTeacher.findFirst({
            where: {
              teacherId: teacher.id,
              ...(isClassArm ? { classArmId: classId } : { classId }),
              OR: [{ isFormTeacher: true }, { isPrimary: true }],
            },
          });
          classWideReport = !!formAssignment;
        }
        if (!classWideReport) {
          where.teacherId = teacher.id;
        } else {
          where.isPublished = true;
        }
      }
    }

    // Get all grades for the class
    const grades = await this.prisma.grade.findMany({
      where,
      include: {
        enrollment: {
          include: {
            student: true,
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
      orderBy: [{ assessmentDate: 'desc' }, { createdAt: 'desc' }],
    });

    // Group grades by student
    const studentGradesMap = new Map();

    enrollments.forEach((enrollment) => {
      const studentId = enrollment.student.id;
      const studentGrades = grades.filter((grade) => grade.enrollmentId === enrollment.id);

      // Calculate aggregated metrics
      const totalScore = studentGrades.reduce((sum, grade) => sum + grade.score.toNumber(), 0);
      const totalMaxScore = studentGrades.reduce((sum, grade) => sum + grade.maxScore.toNumber(), 0);
      const averagePercentage = totalMaxScore > 0 ? (totalScore / totalMaxScore) * 100 : 0;
      const gradedCount = studentGrades.filter((grade) => grade.isPublished).length;
      const totalCount = studentGrades.length;

      // Determine performance relative to class average
      let performanceStatus = 'average';
      if (averagePercentage >= 80) {
        performanceStatus = 'above';
      } else if (averagePercentage < 60) {
        performanceStatus = 'below';
      }

      studentGradesMap.set(studentId, {
        student: {
          id: enrollment.student.id,
          firstName: enrollment.student.firstName,
          lastName: enrollment.student.lastName,
          uid: enrollment.student.uid,
          publicId: enrollment.student.publicId,
        },
        averagePercentage: Math.round(averagePercentage * 10) / 10,
        gradedCount,
        totalCount,
        performanceStatus,
        grades: studentGrades.map((grade) => ({
          id: grade.id,
          assessmentName: grade.assessmentName,
          assessmentDate: grade.assessmentDate,
          gradeType: grade.gradeType,
          sequence: grade.sequence,
          score: grade.score.toNumber(),
          maxScore: grade.maxScore.toNumber(),
          percentage: grade.maxScore.toNumber() > 0 ? 
            Math.round((grade.score.toNumber() / grade.maxScore.toNumber()) * 100 * 10) / 10 : 0,
          isPublished: grade.isPublished,
          gradedAt: grade.updatedAt,
          subject: grade.subject,
          teacher: grade.teacher
            ? {
                firstName: grade.teacher.firstName,
                lastName: grade.teacher.lastName,
              }
            : null,
        })),
      });
    });

    // Convert to array and sort by student name
    return Array.from(studentGradesMap.values()).sort((a, b) => 
      `${a.student.firstName} ${a.student.lastName}`.localeCompare(
        `${b.student.firstName} ${b.student.lastName}`
      )
    );
  }
}
