import { Injectable } from '@nestjs/common';
import { SchoolAdmin, Teacher } from '@prisma/client';

/**
 * Mapper for converting Staff entities to DTOs
 * Follows the mapper pattern for separation of concerns
 */
@Injectable()
export class StaffMapper {
  /**
   * Convert SchoolAdmin entity to AdminDto
   */
  toAdminDto(admin: SchoolAdmin & { user?: any; school?: any }) {
    return {
      id: admin.id,
      adminId: admin.adminId,
      firstName: admin.firstName,
      lastName: admin.lastName,
      email: admin.email,
      phone: admin.phone,
      role: admin.role,
      accessTier: admin.accessTier,
      schoolType: admin.schoolType,
      profileImage: admin.profileImage,
      publicId: admin.publicId,
      userId: admin.userId, // Include userId for resend email functionality
      createdAt: admin.createdAt,
      user: admin.user
        ? {
          id: admin.user.id,
          email: admin.user.email,
          phone: admin.user.phone,
          role: admin.user.role,
          accountStatus: admin.user.accountStatus,
        }
        : undefined,
      school: admin.school
        ? {
          id: admin.school.id,
          name: admin.school.name,
          schoolId: admin.school.schoolId,
        }
        : undefined,
    };
  }

  /**
   * Convert Teacher entity to TeacherDto
   */
  toTeacherDto(teacher: Teacher & { user?: any; school?: any }) {
    return {
      id: teacher.id,
      teacherId: teacher.teacherId,
      firstName: teacher.firstName,
      lastName: teacher.lastName,
      email: teacher.email,
      phone: teacher.phone,
      employeeId: teacher.employeeId,
      subject: teacher.subject,
      isTemporary: teacher.isTemporary,
      schoolType: teacher.schoolType,
      profileImage: teacher.profileImage,
      publicId: teacher.publicId,
      userId: teacher.userId, // Include userId for resend email functionality
      createdAt: teacher.createdAt,
      user: teacher.user
        ? {
          id: teacher.user.id,
          email: teacher.user.email,
          phone: teacher.user.phone,
          role: teacher.user.role,
          accountStatus: teacher.user.accountStatus,
        }
        : undefined,
      school: teacher.school
        ? {
          id: teacher.school.id,
          name: teacher.school.name,
          schoolId: teacher.school.schoolId,
        }
        : undefined,
    };
  }

  /**
   * Convert array of SchoolAdmin entities to AdminDto array
   */
  toAdminDtoArray(admins: (SchoolAdmin & { user?: any; school?: any })[]) {
    return admins.map((admin) => this.toAdminDto(admin));
  }

  /**
   * Convert array of Teacher entities to TeacherDto array
   */
  toTeacherDtoArray(teachers: (Teacher & { user?: any; school?: any })[]) {
    return teachers.map((teacher) => this.toTeacherDto(teacher));
  }
}
