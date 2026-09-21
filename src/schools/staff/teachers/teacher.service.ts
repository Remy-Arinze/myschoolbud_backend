import {
  Injectable,
  ConflictException,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { AuthService } from '../../../auth/auth.service';
import { SchoolRepository } from '../../domain/repositories/school.repository';
import { StaffRepository } from '../../domain/repositories/staff.repository';
import { StaffMapper } from '../../domain/mappers/staff.mapper';
import { IdGeneratorService } from '../../shared/id-generator.service';
import { StaffValidatorService } from '../../shared/staff-validator.service';
import { AddTeacherDto } from '../../dto/add-teacher.dto';
import { UpdateTeacherDto } from '../../dto/update-teacher.dto';
import { CloudinaryService } from '../../../storage/cloudinary/cloudinary.service';
import { ClassService } from '../../classes/class.service';
import { SubscriptionsService } from '../../../subscriptions/subscriptions.service';
import { hasPrincipalAccess, isSchoolOwnerRole } from '../../dto/permission.dto';
import { UserWithContext } from '../../../auth/types/user-with-context.type';
import { generateSecurePasswordHash } from '../../../common/utils/password.utils';
import { NotificationService } from '../../../notification/notification.service';

/**
 * Service for managing teachers
 * Handles creating, updating, and deleting teachers
 */
@Injectable()
export class TeacherService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
    private readonly schoolRepository: SchoolRepository,
    private readonly staffRepository: StaffRepository,
    private readonly staffMapper: StaffMapper,
    private readonly idGenerator: IdGeneratorService,
    private readonly staffValidator: StaffValidatorService,
    private readonly cloudinaryService: CloudinaryService,
    private readonly classService: ClassService,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly notificationService: NotificationService,
  ) { }

  /**
   * Add a teacher to a school
   */
  async addTeacher(schoolId: string, teacherData: AddTeacherDto): Promise<any> {
    // Validate school exists
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    // Check teacher limit based on subscription tier
    const teacherLimit = await this.subscriptionsService.checkTeacherLimit(school.id);
    if (!teacherLimit.canAdd) {
      throw new ForbiddenException(teacherLimit.message);
    }

    // Validate staff data
    this.staffValidator.validateStaffData(teacherData);

    // Validate email and phone are unique in school
    await this.staffValidator.validateEmailUniqueInSchool(teacherData.email, school.id);
    await this.staffValidator.validatePhoneUniqueInSchool(teacherData.phone, school.id);

    const defaultPassword = await generateSecurePasswordHash();

    // Generate teacher ID and public ID
    const teacherId = await this.idGenerator.generateTeacherId();
    const publicId = await this.idGenerator.generatePublicId(school.name, 'teacher');

    // Create user and teacher in transaction
    const result = await this.prisma.$transaction(async (tx) => {
      try {
        // Find or create user
        let teacherUser = await tx.user.findUnique({
          where: { email: teacherData.email },
        });

        if (!teacherUser) {
          teacherUser = await tx.user.create({
            data: {
              email: teacherData.email,
              phone: teacherData.phone,
              passwordHash: defaultPassword,
              accountStatus: 'SHADOW', // User needs to activate via email
              role: 'TEACHER',
            },
          });
        } else {
          teacherUser = await tx.user.update({
            where: { id: teacherUser.id },
            data: {
              passwordHash: defaultPassword,
              // Don't change accountStatus if user already exists - they may already be active
              role: 'TEACHER',
            },
          });
        }

        // Create teacher - use transaction client directly
        const newTeacher = await tx.teacher.create({
          data: {
            teacherId: teacherId,
            publicId: publicId,
            firstName: teacherData.firstName,
            lastName: teacherData.lastName,
            email: teacherData.email,
            phone: teacherData.phone,
            subject: teacherData.subject || null,
            profileImage: teacherData.profileImage || null,
            isTemporary: teacherData.isTemporary || false,
            employeeId: teacherData.employeeId || null,
            schoolType: teacherData.schoolType || null,
            userId: teacherUser.id,
            schoolId: school.id,
          },
          include: { user: true, school: true },
        });

        return { teacher: newTeacher, user: teacherUser };
      } catch (error: any) {
        if (error.code === 'P2002') {
          const target = error.meta?.target;
          if (Array.isArray(target) && target.includes('email')) {
            throw new ConflictException(`User with email ${teacherData.email} already exists`);
          }
          if (Array.isArray(target) && target.includes('phone')) {
            throw new ConflictException(
              `User with phone number ${teacherData.phone} already exists`
            );
          }
        }
        throw error;
      }
    });

    // Send password reset email
    let emailFailed = false;
    try {
      await this.authService.sendPasswordResetForNewUser(
        result.user.id,
        teacherData.email,
        `${teacherData.firstName} ${teacherData.lastName}`,
        'Teacher',
        result.teacher.publicId,
        result.teacher.school.name
      );
    } catch (error) {
      emailFailed = true;
      console.error('Failed to send password reset email to teacher:', error);
    }

    // If subjectIds provided, create SubjectTeacher records with enhanced validation
    if (teacherData.subjectIds && teacherData.subjectIds.length > 0) {
      try {
        // Validate all subject IDs belong to this school and check agora subject consistency
        for (const subjectId of teacherData.subjectIds) {
          const subject = await this.prisma.subject.findFirst({
            where: {
              id: subjectId,
              schoolId: school.id,
            },
            include: {
              agoraSubject: {
                select: { id: true, name: true, code: true }
              }
            }
          });

          if (!subject) {
            console.error(`Subject ${subjectId} not found in school`);
            continue;
          }

          // Validate agora subject consistency
          if (subject.agoraSubjectId && !subject.agoraSubject) {
            console.error(`Subject ${subject.name} has invalid agora subject reference ${subject.agoraSubjectId}`);
            continue;
          }

          // Create SubjectTeacher record
          await this.prisma.subjectTeacher
            .create({
              data: {
                teacherId: result.teacher.id,
                subjectId: subjectId,
              },
            });
        }
      } catch (error) {
        console.error('Failed to assign subjects to teacher:', error);
        // Don't fail the whole operation, subjects can be added later
      }
    }

    // For PRIMARY schools: assign teacher to class arm if classArmId was provided
    if (teacherData.classArmId && result.teacher.id) {
      // Check if the class arm already has a primary teacher before assigning
      const existingPrimaryTeacher = await this.prisma.classTeacher.findFirst({
        where: {
          classArmId: teacherData.classArmId,
          isPrimary: true,
        },
        include: { teacher: { select: { firstName: true, lastName: true } } },
      });

      if (existingPrimaryTeacher) {
        const teacherName = `${existingPrimaryTeacher.teacher.firstName} ${existingPrimaryTeacher.teacher.lastName}`;
        console.warn(
          `Class arm ${teacherData.classArmId} already has a primary teacher (${teacherName}). Skipping assignment.`,
        );
        // Teacher was created successfully — return with a warning flag
        const teacherDto = this.staffMapper.toTeacherDto(result.teacher);
        return {
          data: teacherDto,
          emailFailed,
          classAssignmentSkipped: true,
          classAssignmentReason: `This class already has a teacher assigned (${teacherName}). Please unassign them first.`,
        };
      }

      try {
        await this.classService.assignTeacherToClass(school.id, teacherData.classArmId, {
          teacherId: result.teacher.id,
          isPrimary: true,
        });
      } catch (error) {
        console.error(
          `Failed to assign teacher ${result.teacher.id} to class arm ${teacherData.classArmId}:`,
          error,
        );
        // Don't fail teacher creation — the assignment can be done manually later
      }
    }

    try {
      void this.notificationService.notifySchoolAdmins(school.id, {
        type: 'STAFF_INVITED',
        title: 'Teacher invited',
        body: `${teacherData.firstName} ${teacherData.lastName} was added as a teacher.`,
        link: '/dashboard/school/staff',
        metadata: { teacherId: result.teacher.id, userId: result.user.id },
      });
    } catch {
      // Staff creation must not depend on notification delivery.
    }

    const teacherDto = this.staffMapper.toTeacherDto(result.teacher);
    return { data: teacherDto, emailFailed };
  }

  /**
   * Update a teacher
   */
  async updateTeacher(
    schoolId: string,
    teacherId: string,
    updateData: UpdateTeacherDto
  ): Promise<any> {
    // Validate school exists
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    // Validate teacher exists in school
    const teacher = await this.staffRepository.findTeacherById(teacherId);
    if (!teacher || teacher.schoolId !== school.id) {
      throw new BadRequestException('Teacher not found in this school');
    }

    // Validate staff data if provided
    if (updateData.firstName || updateData.lastName || updateData.phone) {
      this.staffValidator.validateStaffData({
        firstName: updateData.firstName,
        lastName: updateData.lastName,
        phone: updateData.phone,
      });
    }

    // Update teacher
    const updatedTeacher = await this.staffRepository.updateTeacher(teacherId, {
      firstName: updateData.firstName,
      lastName: updateData.lastName,
      phone: updateData.phone,
      subject: updateData.subject,
      isTemporary: updateData.isTemporary,
      profileImage: updateData.profileImage,
      schoolType: updateData.schoolType,
    });

    return this.staffMapper.toTeacherDto(updatedTeacher);
  }

  /**
   * Upload teacher profile image
   */
  async uploadProfileImage(
    schoolId: string,
    teacherId: string,
    file: Express.Multer.File
  ): Promise<any> {
    // Validate school exists
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    // Validate teacher exists in school
    const teacher = await this.staffRepository.findTeacherById(teacherId);
    if (!teacher || teacher.schoolId !== school.id) {
      throw new NotFoundException('Teacher not found in this school');
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

    // Delete old image if exists
    if (teacher.profileImage) {
      const oldPublicId = this.cloudinaryService.extractPublicId(teacher.profileImage);
      if (oldPublicId) {
        try {
          await this.cloudinaryService.deleteImage(oldPublicId);
        } catch (error) {
          console.error('Error deleting old profile image:', error);
          // Continue even if deletion fails
        }
      }
    }

    // Upload to Cloudinary
    const { url } = await this.cloudinaryService.uploadImage(
      file,
      `schools/${schoolId}/staff/teachers`,
      `teacher-${teacherId}`
    );

    // Update teacher with new image URL
    const updatedTeacher = await this.staffRepository.updateTeacher(teacherId, {
      profileImage: url,
    });

    return this.staffMapper.toTeacherDto(updatedTeacher);
  }

  /**
   * Delete a teacher with role-hierarchy authorization.
   *
   * Only school_owner and principal-level roles can delete teachers.
   */
  async deleteTeacher(schoolId: string, teacherId: string, requestingUser: UserWithContext): Promise<void> {
    // Validate school exists
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    // Validate teacher exists in school
    const teacher = await this.staffRepository.findTeacherById(teacherId);
    if (!teacher || teacher.schoolId !== school.id) {
      throw new BadRequestException('Teacher not found in this school');
    }

    // Get the requesting admin's profile in this school
    const requestingAdmin = await this.prisma.schoolAdmin.findFirst({
      where: { userId: requestingUser.id, schoolId: school.id },
    });

    if (!requestingAdmin) {
      throw new ForbiddenException('You do not have an admin profile in this school');
    }

    const isRequestingSchoolOwner = isSchoolOwnerRole(requestingAdmin.role);
    const isRequestingPrincipalLevel = hasPrincipalAccess(requestingAdmin);

    // Only school_owner and principal-level roles can delete teachers
    if (!isRequestingSchoolOwner && !isRequestingPrincipalLevel) {
      throw new ForbiddenException(
        'Only school owners and principal-level administrators can delete teachers'
      );
    }

    await this.staffRepository.deleteTeacher(teacherId);
  }

  /**
   * Get a teacher by ID
   */
  async getTeacherById(schoolId: string, teacherId: string): Promise<any | null> {
    const teacher = await this.staffRepository.findTeacherById(teacherId);
    if (!teacher || teacher.schoolId !== schoolId) {
      return null;
    }
    return this.staffMapper.toTeacherDto(teacher);
  }
}
