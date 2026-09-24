import { Injectable, BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { SchoolRepository } from '../schools/domain/repositories/school.repository';
import { IdGeneratorService } from '../schools/shared/id-generator.service';
import { AuthService } from '../auth/auth.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { AddStudentDto } from '../schools/dto/add-student.dto';
import { TermStatus, SessionStatus, AdmissionStatus } from '@prisma/client';
import { generateSecurePasswordHash } from '../common/utils/password.utils';
import { SubmitAdmissionApplicationDto, ApproveAdmissionApplicationDto } from './dto/admission-application.dto';
import { NotificationService } from '../notification/notification.service';
import { SchoolSettingsService } from '../school-settings/school-settings.service';

@Injectable()
export class StudentAdmissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly schoolRepository: SchoolRepository,
    private readonly idGenerator: IdGeneratorService,
    private readonly authService: AuthService,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly notificationService: NotificationService,
    private readonly schoolSettingsService: SchoolSettingsService,
  ) { }

  /**
   * Add a student to a school
   * Checks if student email exists globally (not just in school)
   * If exists, throws error suggesting transfer
   * If new, creates student account and sends email with public ID
   */
  async addStudent(schoolId: string, studentData: AddStudentDto): Promise<any> {
    // Validate school exists
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    // Check student limit based on subscription tier
    const studentLimit = await this.subscriptionsService.checkStudentLimit(school.id);
    if (!studentLimit.canAdd) {
      throw new ForbiddenException(studentLimit.message);
    }

    // Check if student email exists globally (in entire Agora system)
    if (studentData.email) {
      const existingUser = await this.prisma.user.findUnique({
        where: { email: studentData.email },
        include: {
          studentProfile: true,
        },
      });

      if (existingUser && existingUser.studentProfile) {
        // Student already exists in Agora system
        throw new ConflictException(
          `A student with email ${studentData.email} already exists in the Myschoolbud system. ` +
          `Please initiate a transfer instead of creating a new admission.`
        );
      }
    }

    // Validate required fields
    if (!studentData.firstName || !studentData.lastName || !studentData.dateOfBirth) {
      throw new BadRequestException('First name, last name, and date of birth are required');
    }

    if (!studentData.parentName || !studentData.parentPhone) {
      throw new BadRequestException('Parent/Guardian name and phone are required');
    }

    const defaultPassword = await generateSecurePasswordHash();

    // Generate student UID (admission number) and public ID
    const studentUid = await this.idGenerator.generateStudentId(school.name);
    const publicId = await this.idGenerator.generatePublicId(school.name, 'student');

    // Determine academic year if not provided
    const academicYear = studentData.academicYear || this.getCurrentAcademicYear();

    // Create user, student, parent, and enrollment in transaction
    const result = await this.prisma.$transaction(async (tx) => {
      try {
        // Find or create parent record (no User account needed)
        // Check if parent already exists by phone
        let parentProfile = await tx.parent.findFirst({
          where: { phone: studentData.parentPhone },
        });

        if (!parentProfile) {
          // Create parent profile without User account
          parentProfile = await tx.parent.create({
            data: {
              firstName: studentData.parentName.split(' ')[0] || studentData.parentName,
              lastName: studentData.parentName.split(' ').slice(1).join(' ') || '',
              phone: studentData.parentPhone,
              email: studentData.parentEmail || null,
              relationship: studentData.parentRelationship,
              userId: null, // No User account for parents
            },
          });
        }

        // Create student user
        const studentUser = await tx.user.create({
          data: {
            email: studentData.email || null,
            phone: studentData.phone,
            passwordHash: defaultPassword,
            accountStatus: 'SHADOW', // User needs to activate via email
            role: 'STUDENT',
          },
        });

        // Create student profile
        const newStudent = await tx.student.create({
          data: {
            uid: studentUid,
            publicId: publicId,
            firstName: studentData.firstName,
            middleName: studentData.middleName || null,
            lastName: studentData.lastName,
            dateOfBirth: new Date(studentData.dateOfBirth),
            profileImage: studentData.profileImage || null,
            nationality: studentData.nationality || null,
            state: studentData.state || null,
            userId: studentUser.id,
          },
          include: {
            user: true,
          },
        });

        // Link parent to student
        await tx.studentGuardian.create({
          data: {
            studentId: newStudent.id,
            parentId: parentProfile.id,
            relationship: studentData.parentRelationship,
            isPrimary: true,
          },
        });

        // Find active term to link enrollment to
        const activeTerm = await tx.term.findFirst({
          where: {
            status: TermStatus.ACTIVE,
            academicSession: {
              schoolId: school.id,
              status: SessionStatus.ACTIVE,
            },
          },
          orderBy: {
            number: 'desc',
          },
        });

        // Handle ClassArm enrollment (for PRIMARY/SECONDARY schools using ClassArms)
        let enrollmentClassLevel = studentData.classLevel;
        let enrollmentClassArmId: string | null = null;
        let enrollmentClassId: string | null = null;

        if (studentData.classArmId) {
          // Validate ClassArm exists and belongs to school
          const classArm = await tx.classArm.findUnique({
            where: { id: studentData.classArmId },
            include: {
              classLevel: true,
            },
          });

          if (!classArm || classArm.classLevel.schoolId !== school.id) {
            throw new BadRequestException('ClassArm not found or does not belong to this school');
          }

          // Validate capacity if set
          if (classArm.capacity !== null) {
            const currentEnrollments = await tx.enrollment.count({
              where: {
                classArmId: classArm.id,
                isActive: true,
                academicYear,
              },
            });

            if (currentEnrollments >= classArm.capacity) {
              throw new BadRequestException(
                `ClassArm "${classArm.name}" is at full capacity (${classArm.capacity} students)`
              );
            }
          }

          enrollmentClassArmId = classArm.id;
          enrollmentClassLevel = classArm.classLevel.name; // Auto-populate from ClassArm's ClassLevel
        } else if (studentData.classLevel) {
          // Fallback to Class (for schools without ClassArms or TERTIARY - backward compatibility)
          // Try to find a matching Class
          const matchingClass = await tx.class.findFirst({
            where: {
              schoolId: school.id,
              academicYear: academicYear,
              OR: [{ name: studentData.classLevel }, { classLevel: studentData.classLevel }],
              isActive: true,
            },
          });

          if (matchingClass) {
            enrollmentClassId = matchingClass.id;
          }
          // If no matching class found, enrollment will be created with just classLevel (backward compatibility)
        } else {
          throw new BadRequestException('Either classArmId or classLevel must be provided');
        }

        // Create enrollment with term link
        // enrollmentClassLevel is guaranteed to be defined at this point due to validation above
        if (!enrollmentClassLevel) {
          throw new BadRequestException('Class level is required for enrollment');
        }

        await tx.enrollment.create({
          data: {
            studentId: newStudent.id,
            schoolId: school.id,
            classArmId: enrollmentClassArmId,
            classId: enrollmentClassId,
            classLevel: enrollmentClassLevel,
            academicYear: academicYear,
            isActive: true,
            termId: activeTerm?.id || null, // Link to active term if exists
          },
        });

        return { student: newStudent, user: studentUser, publicId };
      } catch (error: any) {
        if (error.code === 'P2002') {
          const target = error.meta?.target;
          if (Array.isArray(target) && target.includes('email')) {
            throw new ConflictException(`User with email ${studentData.email} already exists`);
          }
          if (Array.isArray(target) && target.includes('phone')) {
            throw new ConflictException(
              `User with phone number ${studentData.phone} already exists`
            );
          }
          if (Array.isArray(target) && target.includes('publicId')) {
            throw new ConflictException('Public ID conflict. Please try again.');
          }
          if (Array.isArray(target) && target.includes('uid')) {
            throw new ConflictException('Student ID (UID) conflict. Please try again.');
          }
        }
        throw error;
      }
    });

    // Send password reset email with public ID (outside transaction)
    if (studentData.email) {
      try {
        await this.authService.sendPasswordResetForNewUser(
          result.user.id,
          studentData.email,
          `${studentData.firstName} ${studentData.lastName}`,
          'Student',
          result.publicId,
          school.name,
          result.student.uid
        );
      } catch (error) {
        console.error('Failed to send password reset email to student:', error);
        // Don't throw - student is created, email failure is non-critical
      }
    }

    return {
      id: result.student.id,
      uid: result.student.uid,
      publicId: result.publicId,
      firstName: result.student.firstName,
      lastName: result.student.lastName,
      email: result.user.email,
      message: studentData.email
        ? 'Student created successfully. An email with login credentials has been sent.'
        : 'Student created successfully. Please provide the student with their Public ID for login.',
    };
  }

  /**
   * Submit an admission application (public)
   */
  async submitApplication(schoolId: string, dto: SubmitAdmissionApplicationDto) {
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    const admissionPolicy = await this.schoolSettingsService.getAdmissionPolicy(schoolId);
    if (!admissionPolicy.applicationsOpen) {
      throw new BadRequestException('This school is not currently accepting applications.');
    }
    if (admissionPolicy.applicationDeadline && new Date() > admissionPolicy.applicationDeadline) {
      throw new BadRequestException('The application deadline has passed.');
    }

    const formFields = (admissionPolicy.formFields as Array<{
      key: string;
      required?: boolean;
      visible?: boolean;
    }> | null) ?? [];
    const dtoRecord = dto as unknown as Record<string, unknown>;
    const systemKeys = new Set(['classLevel', 'classArmId', 'academicYear', 'profileImage']);
    const allowedKeys = new Set([...formFields.map((f) => f.key), ...systemKeys]);
    if (formFields.length > 0) {
      for (const [key, value] of Object.entries(dtoRecord)) {
        if (value == null || String(value).trim() === '') continue;
        if (!allowedKeys.has(key)) {
          throw new BadRequestException(`Unexpected field: ${key}`);
        }
      }
    }
    for (const field of formFields) {
      if (field.visible === false) continue;
      if (!field.required) continue;
      const value = dtoRecord[field.key];
      if (value == null || String(value).trim() === '') {
        throw new BadRequestException(`${field.key} is required.`);
      }
    }

    // Check if student email exists globally
    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.email },
      include: { studentProfile: true },
    });

    if (existingUser && existingUser.studentProfile) {
      throw new ConflictException(
        `A student with email ${dto.email} already exists in the Myschoolbud system. ` +
        `Please log in and initiate a transfer instead.`
      );
    }

    const application = await this.prisma.admissionApplication.create({
      data: {
        schoolId,
        firstName: dto.firstName,
        middleName: dto.middleName,
        lastName: dto.lastName,
        email: dto.email,
        phone: dto.phone,
        dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : new Date('1970-01-01'),
        gender: dto.gender || 'UNSPECIFIED',
        address: dto.address,
        nationality: dto.nationality || '',
        state: dto.state || '',
        classLevel: dto.classLevel,
        classArmId: dto.classArmId,
        academicYear: dto.academicYear,
        parentName: dto.parentName || '',
        parentPhone: dto.parentPhone || '',
        parentEmail: dto.parentEmail,
        parentRelationship: dto.parentRelationship || '',
        bloodGroup: dto.bloodGroup,
        allergies: dto.allergies,
        medications: dto.medications,
        emergencyContact: dto.emergencyContact,
        emergencyContactPhone: dto.emergencyContactPhone,
        medicalNotes: dto.medicalNotes,
        status: AdmissionStatus.PENDING,
      },
    });

    try {
      void this.notificationService.notifySchoolAdmins(schoolId, {
        type: 'ADMISSION_SUBMITTED',
        title: 'New application',
        subtitle: `${dto.firstName} ${dto.lastName}`,
        body: `${dto.firstName} ${dto.lastName} submitted an admission application. It is waiting for review.`,
        link: '/dashboard/school/applications',
        metadata: { applicationId: application.id },
      });
    } catch {
      // Notifications must never interrupt a public application submission.
    }

    return application;
  }

  /**
   * Get applications for a school
   */
  async getApplications(schoolId: string, status?: AdmissionStatus) {
    return this.prisma.admissionApplication.findMany({
      where: {
        schoolId,
        ...(status ? { status } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Approve an application and admit student
   */
  async approveApplication(schoolId: string, applicationId: string, approvalDto: ApproveAdmissionApplicationDto, reviewerId: string) {
    const application = await this.prisma.admissionApplication.findUnique({
      where: { id: applicationId },
    });

    if (!application || application.schoolId !== schoolId) {
      throw new NotFoundException('Application not found');
    }

    if (application.status !== AdmissionStatus.PENDING) {
      throw new BadRequestException('Application is already processed');
    }

    // Convert application data to AddStudentDto
    const studentData: AddStudentDto = {
      firstName: application.firstName,
      middleName: application.middleName || undefined,
      lastName: application.lastName,
      email: application.email,
      phone: application.phone || undefined,
      dateOfBirth: application.dateOfBirth.toISOString(),
      gender: application.gender,
      address: application.address || undefined,
      nationality: application.nationality,
      state: application.state,
      classLevel: approvalDto.classLevel || application.classLevel || undefined,
      classArmId: approvalDto.classArmId || application.classArmId || undefined,
      academicYear: approvalDto.academicYear || application.academicYear || undefined,
      parentName: application.parentName,
      parentPhone: application.parentPhone,
      parentEmail: application.parentEmail || undefined,
      parentRelationship: application.parentRelationship,
    } as any;

    // Use existing addStudent logic
    const result = await this.addStudent(schoolId, studentData);

    // Update application status
    await this.prisma.admissionApplication.update({
      where: { id: applicationId },
      data: {
        status: AdmissionStatus.ACCEPTED,
        reviewedBy: reviewerId,
        reviewedAt: new Date(),
      },
    });

    try {
      const user = application.email
        ? await this.prisma.user.findUnique({ where: { email: application.email }, select: { id: true } })
        : null;
      if (user) {
        void this.notificationService.notifyUsers([user.id], {
          schoolId,
          role: 'STUDENT',
          type: 'APPLICATION_APPROVED',
          title: 'Application approved',
          subtitle: 'Admission application',
          body: 'Your admission application has been approved.',
          link: '/dashboard/student/overview',
          metadata: { applicationId },
        });
      }
    } catch {
      // Admission completion is independent of notification delivery.
    }

    return result;
  }

  /**
   * Reject an application
   */
  async rejectApplication(schoolId: string, applicationId: string, reason: string, reviewerId: string) {
    const application = await this.prisma.admissionApplication.findUnique({
      where: { id: applicationId },
    });

    if (!application || application.schoolId !== schoolId) {
      throw new NotFoundException('Application not found');
    }

    const rejected = await this.prisma.admissionApplication.update({
      where: { id: applicationId },
      data: {
        status: AdmissionStatus.DECLINED,
        rejectionReason: reason,
        reviewedBy: reviewerId,
        reviewedAt: new Date(),
      },
    });

    try {
      const user = application.email
        ? await this.prisma.user.findUnique({ where: { email: application.email }, select: { id: true } })
        : null;
      if (user) {
        void this.notificationService.notifyUsers([user.id], {
          schoolId,
          role: 'STUDENT',
          type: 'APPLICATION_REJECTED',
          title: 'Application not approved',
          subtitle: 'Admission application',
          body: 'Your application was not approved.',
          link: '/dashboard/student/overview',
          metadata: { applicationId },
        });
      }
    } catch {
      // Rejection must remain successful when notification delivery fails.
    }

    return rejected;
  }

  /**
   * Get current academic year in format YYYY/YYYY+1
   */
  private getCurrentAcademicYear(): string {
    const now = new Date();
    const year = now.getFullYear();
    // If we're past September, it's the new academic year
    if (now.getMonth() >= 8) {
      return `${year}/${year + 1}`;
    }
    return `${year - 1}/${year}`;
  }
}
