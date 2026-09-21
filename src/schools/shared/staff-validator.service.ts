import { Injectable, ConflictException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import {
  isPrincipalRole,
  isSchoolOwnerRole,
  canonicalizeUniqueTitle,
  isUniqueAdminTitle,
  uniqueTitleDisplayName,
} from '../dto/permission.dto';

/**
 * Service for validating staff-related operations
 * Centralizes validation logic to ensure consistency
 */
@Injectable()
export class StaffValidatorService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Validate that email is unique within a school
   */
  async validateEmailUniqueInSchool(
    email: string,
    schoolId: string,
    excludeAdminId?: string,
    excludeTeacherId?: string
  ): Promise<void> {
    const existingAdmin = await this.prisma.schoolAdmin.findFirst({
      where: {
        email,
        schoolId,
        ...(excludeAdminId && { id: { not: excludeAdminId } }),
      },
    });

    if (existingAdmin) {
      throw new ConflictException(
        `An administrator with email ${email} already exists in this school`
      );
    }

    const existingTeacher = await this.prisma.teacher.findFirst({
      where: {
        email,
        schoolId,
        ...(excludeTeacherId && { id: { not: excludeTeacherId } }),
      },
    });

    if (existingTeacher) {
      throw new ConflictException(`A teacher with email ${email} already exists in this school`);
    }
  }

  /**
   * Validate that phone is unique within a school
   */
  async validatePhoneUniqueInSchool(
    phone: string,
    schoolId: string,
    excludeAdminId?: string,
    excludeTeacherId?: string
  ): Promise<void> {
    const existingAdmin = await this.prisma.schoolAdmin.findFirst({
      where: {
        phone,
        schoolId,
        ...(excludeAdminId && { id: { not: excludeAdminId } }),
      },
    });

    if (existingAdmin) {
      throw new ConflictException(
        `An administrator with phone number ${phone} already exists in this school`
      );
    }

    const existingTeacher = await this.prisma.teacher.findFirst({
      where: {
        phone,
        schoolId,
        ...(excludeTeacherId && { id: { not: excludeTeacherId } }),
      },
    });

    if (existingTeacher) {
      throw new ConflictException(
        `A teacher with phone number ${phone} already exists in this school`
      );
    }
  }

  /**
   * Validate staff data before creation/update
   */
  validateStaffData(data: {
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    role?: string;
  }): void {
    if (data.firstName && data.firstName.trim().length < 2) {
      throw new BadRequestException('First name must be at least 2 characters');
    }

    if (data.lastName && data.lastName.trim().length < 2) {
      throw new BadRequestException('Last name must be at least 2 characters');
    }

    if (data.email && !this.isValidEmail(data.email)) {
      throw new BadRequestException('Invalid email format');
    }

    if (data.phone && !this.isValidPhone(data.phone)) {
      throw new BadRequestException('Invalid phone format');
    }

    if (data.role && data.role.trim().length < 2) {
      throw new BadRequestException('Role must be at least 2 characters');
    }

    if (data.role && data.role.length > 50) {
      throw new BadRequestException('Role must be at most 50 characters');
    }
  }

  /**
   * Unique principal-level seats: one school_owner, one principal
   * (school_principal is the same seat), and one each of head_teacher /
   * headmaster / headmistress. VP and other staff titles are unlimited.
   */
  async validateUniqueCanonicalTitle(
    schoolId: string,
    role: string,
    excludeAdminId?: string,
  ): Promise<void> {
    if (!isUniqueAdminTitle(role)) {
      return;
    }

    const canonical = canonicalizeUniqueTitle(role);
    const admins = await this.prisma.schoolAdmin.findMany({
      where: { schoolId },
      select: { id: true, role: true },
    });

    const clash = admins.find(
      (admin) =>
        admin.id !== excludeAdminId &&
        canonicalizeUniqueTitle(admin.role) === canonical,
    );

    if (clash) {
      throw new ConflictException(
        `This school already has a ${uniqueTitleDisplayName(role)}.`,
      );
    }
  }

  /**
   * Who may hand out a permission-bypassing tier: the School Owner, or a
   * super-admin provisioning a school.
   *
   * Separate from {@link assertCanAssignPrincipalTitle} because the tier is now
   * independent of the title — granting PRINCIPAL under a custom title like
   * "Proprietor" must be gated just as tightly as the recognised seats.
   *
   * The owner seat itself is still identified by title, which is safe: nobody can
   * type `school_owner` (this class forbids minting it), so the system writes it.
   */
  assertCanGrantPrincipalTier(
    requestingAdminRole: string | null | undefined,
    requestingUserRole?: string,
  ): void {
    if (requestingUserRole === 'SUPER_ADMIN') {
      return;
    }

    if (!isSchoolOwnerRole(requestingAdminRole)) {
      throw new ForbiddenException(
        'Only the School Owner can grant principal-level access',
      );
    }
  }

  /**
   * School Owner title cannot be minted. Other principal titles are owner-only,
   * except when a super-admin is provisioning extra admins on a school.
   */
  assertCanAssignPrincipalTitle(
    requestingAdminRole: string | null | undefined,
    targetRole: string,
    requestingUserRole?: string,
  ): void {
    if (!isPrincipalRole(targetRole)) {
      return;
    }

    if (canonicalizeUniqueTitle(targetRole) === 'school_owner') {
      throw new ForbiddenException('Nobody else may be given the School Owner title.');
    }

    if (requestingUserRole === 'SUPER_ADMIN') {
      return;
    }

    if (!isSchoolOwnerRole(requestingAdminRole)) {
      throw new ForbiddenException(
        'Only the School Owner can assign principal-level titles',
      );
    }
  }

  /**
   * Validate that a unique principal-level title is not already filled.
   */
  async validatePrincipalRole(
    schoolId: string,
    role: string,
    excludeAdminId?: string,
  ): Promise<void> {
    await this.validateUniqueCanonicalTitle(schoolId, role, excludeAdminId);
  }

  private isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  private isValidPhone(phone: string): boolean {
    // Basic phone validation - can be enhanced
    const phoneRegex = /^\+?[1-9]\d{1,14}$/;
    return phoneRegex.test(phone.replace(/\s/g, ''));
  }
}
