import {
  Injectable,
  ConflictException,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { AuthService } from '../../../auth/auth.service';
import { SchoolRepository } from '../../domain/repositories/school.repository';
import { StaffRepository } from '../../domain/repositories/staff.repository';
import { StaffMapper } from '../../domain/mappers/staff.mapper';
import { IdGeneratorService } from '../../shared/id-generator.service';
import { StaffValidatorService } from '../../shared/staff-validator.service';
import { SubscriptionsService } from '../../../subscriptions/subscriptions.service';
import { AddAdminDto } from '../../dto/add-admin.dto';
import { UpdateAdminDto } from '../../dto/update-admin.dto';
import { ChangeAccessTierDto, MakePrincipalDto } from '../../dto/change-access-tier.dto';
import { CloudinaryService } from '../../../storage/cloudinary/cloudinary.service';
import {
  AdminAccessTier,
  PermissionResource,
  PermissionType,
  hasPrincipalAccess,
  isPrincipalRole,
  isSchoolOwnerRole,
  canonicalizeUniqueTitle,
} from '../../dto/permission.dto';
import { UserWithContext } from '../../../auth/types/user-with-context.type';
import { generateSecurePasswordHash } from '../../../common/utils/password.utils';
import { NotificationService } from '../../../notification/notification.service';
import { RoleTemplateService } from '../permissions/role-template.service';

/**
 * Service for managing school administrators
 * Handles creating, updating, and deleting administrators
 */
@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
    private readonly schoolRepository: SchoolRepository,
    private readonly staffRepository: StaffRepository,
    private readonly staffMapper: StaffMapper,
    private readonly idGenerator: IdGeneratorService,
    private readonly staffValidator: StaffValidatorService,
    private readonly cloudinaryService: CloudinaryService,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly notificationService: NotificationService,
    private readonly roleTemplates: RoleTemplateService,
  ) { }

  /**
   * Add an administrator to a school
   */
  async addAdmin(schoolId: string, adminData: AddAdminDto, requestingUser: UserWithContext): Promise<any> {
    // Validate school exists
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    // Check admin limit based on subscription tier
    const adminLimit = await this.subscriptionsService.checkAdminLimit(school.id);
    if (!adminLimit.canAdd) {
      throw new ForbiddenException(adminLimit.message);
    }

    // Validate staff data
    this.staffValidator.validateStaffData(adminData);

    // Validate email and phone are unique in school
    await this.staffValidator.validateEmailUniqueInSchool(adminData.email, school.id);
    await this.staffValidator.validatePhoneUniqueInSchool(adminData.phone, school.id);

    // Sanitize role
    const sanitizedRole = adminData.role.trim();
    const roleLower = sanitizedRole.toLowerCase();

    // Authority comes from the request, never from the title. Typing "Principal"
    // no longer grants anything — the caller has to ask for the tier deliberately.
    const isPrincipal = adminData.accessTier === AdminAccessTier.PRINCIPAL;

    // Least privilege: access is stated, never inherited. The old behaviour —
    // omit `permissions` and silently receive READ on every screen in the school
    // — meant a new bursar could read grades, staff records and settings on day
    // one because the form did not ask. Principals are exempt: the tier itself
    // is the grant, so there is nothing to state.
    let requestedPermissionIds: string[] = [];
    if (!isPrincipal) {
      if (adminData.roleTemplateId) {
        requestedPermissionIds = await this.roleTemplates.permissionIdsForTemplate(
          school.id,
          adminData.roleTemplateId,
        );
      } else if (Array.isArray(adminData.permissions)) {
        requestedPermissionIds = await this.permissionIdsFor(adminData.permissions);
      } else {
        throw new BadRequestException(
          'Choose what this administrator can see. Pick a role, or tick the access ' +
            'they need — send an empty list only if they should have no dashboard access.',
        );
      }
    }

    // The seat rules still key off the title, so a titled-but-STAFF principal
    // cannot quietly occupy the school's one Principal seat either.
    if (isPrincipal || isPrincipalRole(sanitizedRole)) {
      const requestingAdmin = await this.prisma.schoolAdmin.findFirst({
        where: { userId: requestingUser.id, schoolId: school.id },
      });

      if (!requestingAdmin && requestingUser.role !== 'SUPER_ADMIN') {
        throw new ForbiddenException('You do not have an admin profile in this school');
      }

      if (isPrincipal) {
        this.staffValidator.assertCanGrantPrincipalTier(
          requestingAdmin?.role,
          requestingUser.role,
        );
      }

      this.staffValidator.assertCanAssignPrincipalTitle(
        requestingAdmin?.role,
        sanitizedRole,
        requestingUser.role,
      );

      await this.staffValidator.validateUniqueCanonicalTitle(school.id, sanitizedRole);
    }

    // Validate that the role is not teaching-related
    const teachingKeywords = [
      'teacher',
      'teaching',
      'instructor',
      'lecturer',
      'professor',
      'tutor',
      'educator',
    ];
    const isTeachingRole = teachingKeywords.some(
      (keyword) =>
        roleLower === keyword ||
        roleLower.includes(` ${keyword}`) ||
        roleLower.includes(`${keyword} `) ||
        roleLower.startsWith(keyword) ||
        roleLower.endsWith(keyword)
    );

    if (isTeachingRole) {
      throw new BadRequestException(
        'Cannot set a teaching role as an administrative role. Please use the "Add Teacher" option to add teachers.'
      );
    }

    const defaultPassword = await generateSecurePasswordHash();

    // Generate admin ID and public ID
    const adminId = isPrincipal
      ? await this.idGenerator.generatePrincipalId()
      : await this.idGenerator.generateAdminId();
    const publicId = await this.idGenerator.generatePublicId(school.name, 'admin');

    // Create user and admin in transaction
    const result = await this.prisma.$transaction(async (tx) => {
      try {
        // Find or create user
        let adminUser = await tx.user.findUnique({
          where: { email: adminData.email },
        });

        if (!adminUser) {
          adminUser = await tx.user.create({
            data: {
              email: adminData.email,
              phone: adminData.phone,
              passwordHash: defaultPassword,
              accountStatus: 'SHADOW', // User needs to activate via email
              role: 'SCHOOL_ADMIN',
            },
          });
        } else {
          adminUser = await tx.user.update({
            where: { id: adminUser.id },
            data: {
              passwordHash: defaultPassword,
              // Don't change accountStatus if user already exists - they may already be active
              role: 'SCHOOL_ADMIN',
            },
          });
        }

        // Normalize role name (use underscores for multi-word roles, lowercase)
        const normalizedRole = this.normalizeRoleName(sanitizedRole);

        // Create admin - use transaction client directly
        const newAdmin = await tx.schoolAdmin.create({
          data: {
            adminId: adminId,
            publicId: publicId,
            firstName: adminData.firstName.trim(),
            lastName: adminData.lastName.trim(),
            email: adminData.email.trim().toLowerCase(),
            phone: adminData.phone.trim().replace(/\s+/g, ''),
            role: normalizedRole,
            accessTier: isPrincipal ? AdminAccessTier.PRINCIPAL : AdminAccessTier.STAFF,
            roleTemplateId: isPrincipal ? null : adminData.roleTemplateId || null,
            profileImage: adminData.profileImage || null,
            schoolType: adminData.schoolType?.trim() || null,
            userId: adminUser.id,
            schoolId: school.id,
          },
          include: { user: true, school: true },
        });

        return { admin: newAdmin, user: adminUser };
      } catch (error: any) {
        if (error.code === 'P2002') {
          const target = error.meta?.target;
          if (Array.isArray(target) && target.includes('email')) {
            throw new ConflictException(`User with email ${adminData.email} already exists`);
          }
          if (Array.isArray(target) && target.includes('phone')) {
            throw new ConflictException(`User with phone number ${adminData.phone} already exists`);
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
        adminData.email,
        `${adminData.firstName} ${adminData.lastName}`,
        isPrincipal ? 'Principal' : adminData.role,
        result.admin.publicId,
        result.admin.school.name
      );
    } catch (error) {
      emailFailed = true;
      this.logger.error('Failed to send password reset email to admin:', error);
    }

    // Assign permissions to new admin
    // Principals automatically have full access via PermissionGuard, so skip for them
    if (!isPrincipal) {
      try {
        if (requestedPermissionIds.length > 0) {
          await this.prisma.staffPermission.createMany({
            data: requestedPermissionIds.map((permissionId) => ({
              adminId: result.admin.id,
              permissionId,
            })),
            skipDuplicates: true,
          });
        }
        this.logger.log(
          `[addAdmin] Assigned ${requestedPermissionIds.length} permission rows to admin ${result.admin.id}` +
            (adminData.roleTemplateId ? ` from template ${adminData.roleTemplateId}` : ''),
        );
      } catch (error) {
        this.logger.error(
          'Failed to assign permissions:',
          error instanceof Error ? error.stack : error
        );
        // Don't fail the request if permission assignment fails
      }
    } else {
      this.logger.log(`[addAdmin] Skipping permission assignment for Principal role`);
    }

    try {
      void this.notificationService.notifySchoolAdmins(school.id, {
        type: 'STAFF_INVITED',
        title: 'Administrator invited',
        body: `${adminData.firstName} ${adminData.lastName} was added as an administrator.`,
        link: '/dashboard/school/staff',
        metadata: { adminId: result.admin.id, userId: result.user.id },
      });
    } catch {
      // Staff creation must not depend on notification delivery.
    }

    const adminDto = this.staffMapper.toAdminDto(result.admin);
    return { data: adminDto, emailFailed };
  }

  /**
   * Update an administrator
   */
  async updateAdmin(schoolId: string, adminId: string, updateData: UpdateAdminDto, requestingUser: UserWithContext): Promise<any> {
    // Validate school exists
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    // Validate admin exists in school
    const admin = await this.staffRepository.findAdminById(adminId);
    if (!admin || admin.schoolId !== school.id) {
      throw new BadRequestException('Administrator not found in this school');
    }

    // PREVENT UNAUTHORIZED MODIFICATION OF PRINCIPAL ACCOUNTS
    if (hasPrincipalAccess(admin)) {
      const requestingAdmin = await this.prisma.schoolAdmin.findFirst({
        where: { userId: requestingUser.id, schoolId: school.id },
        select: { id: true, role: true, accessTier: true },
      });
      if (!requestingAdmin || !hasPrincipalAccess(requestingAdmin)) {
        throw new ForbiddenException('Only principal-level administrators can modify principal accounts');
      }
    }

    // Validate staff data if provided
    if (updateData.firstName || updateData.lastName || updateData.phone || updateData.role) {
      this.staffValidator.validateStaffData({
        firstName: updateData.firstName,
        lastName: updateData.lastName,
        phone: updateData.phone,
        role: updateData.role,
      });
    }

    // Renaming a title never changes authority — that is the whole point of the
    // tier. Use PATCH admins/:adminId/access-tier to promote or demote, which
    // forces a replacement permission set so nobody lands on zero access.
    // The seat rules below still apply, so titles cannot collide.
    if (updateData.role) {
      const sanitizedRole = updateData.role.trim();

      if (isPrincipalRole(sanitizedRole)) {
        const requestingAdmin = await this.prisma.schoolAdmin.findFirst({
          where: { userId: requestingUser.id, schoolId: school.id },
        });

        if (!requestingAdmin && requestingUser.role !== 'SUPER_ADMIN') {
          throw new ForbiddenException('You do not have an admin profile in this school');
        }

        this.staffValidator.assertCanAssignPrincipalTitle(
          requestingAdmin?.role,
          sanitizedRole,
          requestingUser.role,
        );

        await this.staffValidator.validateUniqueCanonicalTitle(school.id, sanitizedRole, adminId);
      }
    }

    // Sanitize and normalize update data
    const sanitizedUpdateData: any = {
      firstName: updateData.firstName?.trim(),
      lastName: updateData.lastName?.trim(),
      phone: updateData.phone?.trim().replace(/\s+/g, ''),
      profileImage: updateData.profileImage,
    };

    // Normalize role if provided
    if (updateData.role) {
      sanitizedUpdateData.role = this.normalizeRoleName(updateData.role.trim());
    }

    // Update admin
    const updatedAdmin = await this.staffRepository.updateAdmin(adminId, sanitizedUpdateData);

    return this.staffMapper.toAdminDto(updatedAdmin);
  }

  /**
   * Delete an administrator with role-hierarchy authorization.
   *
   * Deletion rules:
   * - school_owner can NEVER be deleted
   * - Only school_owner can delete principal-level roles (principal, headmistress, etc.)
   * - Principal-level roles can delete regular admins
   * - Regular admins cannot delete anyone (they won't have STAFF:ADMIN permission anyway)
   */
  async deleteAdmin(schoolId: string, adminId: string, requestingUser: UserWithContext): Promise<void> {
    // Validate school exists
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    // Validate target admin exists in school
    const targetAdmin = await this.staffRepository.findAdminById(adminId);
    if (!targetAdmin || targetAdmin.schoolId !== school.id) {
      throw new BadRequestException('Administrator not found in this school');
    }

    // Rule: school_owner can NEVER be deleted
    if (isSchoolOwnerRole(targetAdmin.role)) {
      throw new ForbiddenException('School owner cannot be deleted');
    }

    // Get the requesting admin's profile in this school
    const requestingAdmin = await this.prisma.schoolAdmin.findFirst({
      where: { userId: requestingUser.id, schoolId: school.id },
    });

    if (!requestingAdmin) {
      throw new ForbiddenException('You do not have an admin profile in this school');
    }

    // Owner is a seat (identified by a title only the system writes); "principal
    // level" is authority, which now comes from the tier.
    const isRequestingSchoolOwner = isSchoolOwnerRole(requestingAdmin.role);
    const isRequestingPrincipalLevel = hasPrincipalAccess(requestingAdmin);
    const isTargetPrincipalLevel = hasPrincipalAccess(targetAdmin);

    // Rule: Only school_owner can delete principal-level roles
    if (isTargetPrincipalLevel && !isRequestingSchoolOwner) {
      throw new ForbiddenException(
        'Only the school owner can delete a principal, headmistress, or headmaster'
      );
    }

    // Rule: Must be school_owner or principal-level to delete anyone
    if (!isRequestingSchoolOwner && !isRequestingPrincipalLevel) {
      throw new ForbiddenException(
        'Only school owners and principal-level administrators can delete staff'
      );
    }

    // Rule: Cannot delete yourself
    if (requestingAdmin.id === adminId) {
      throw new BadRequestException('You cannot delete your own account');
    }

    await this.staffRepository.deleteAdmin(adminId);
  }

  /**
   * Change who bypasses the permission system.
   *
   * Promotion grants full access. Demotion has to say what the person keeps —
   * the old title-edit route silently left a demoted principal with zero rows
   * and an empty dashboard, so a replacement set is required here.
   *
   * Tier and permissions land in one transaction: a half-applied demotion is
   * exactly the lockout this is meant to prevent.
   */
  async changeAccessTier(
    schoolId: string,
    adminId: string,
    dto: ChangeAccessTierDto,
    requestingUser: UserWithContext,
  ): Promise<void> {
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    const requestingAdmin = await this.prisma.schoolAdmin.findFirst({
      where: { userId: requestingUser.id, schoolId: school.id },
      select: { id: true, role: true, accessTier: true },
    });

    if (!requestingAdmin && requestingUser.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('You do not have an admin profile in this school');
    }

    // Both directions are owner-only. Granting a bypass and taking one away are
    // equally consequential, and a Principal must not be able to unseat a peer.
    this.staffValidator.assertCanGrantPrincipalTier(
      requestingAdmin?.role,
      requestingUser.role,
    );

    const target = await this.prisma.schoolAdmin.findFirst({
      where: { id: adminId, schoolId: school.id },
      select: { id: true, role: true, accessTier: true },
    });
    if (!target) {
      throw new BadRequestException('Administrator not found in this school');
    }

    // Changing your own tier is how you lock yourself out of your own school.
    if (requestingAdmin && requestingAdmin.id === target.id) {
      throw new BadRequestException('You cannot change your own access level');
    }

    // The owner seat is the floor of the hierarchy; nothing may demote it.
    if (isSchoolOwnerRole(target.role) && dto.accessTier !== AdminAccessTier.PRINCIPAL) {
      throw new BadRequestException('The School Owner cannot be moved off principal-level access');
    }

    if (target.accessTier === dto.accessTier) {
      throw new BadRequestException(
        dto.accessTier === AdminAccessTier.PRINCIPAL
          ? 'This administrator already has principal-level access'
          : 'This administrator is already a staff-level administrator',
      );
    }

    const newTitle = dto.role?.trim();
    if (newTitle) {
      // Titles carry no access, but the seat rules still apply so two people
      // cannot both be called Principal.
      if (isPrincipalRole(newTitle)) {
        this.staffValidator.assertCanAssignPrincipalTitle(
          requestingAdmin?.role,
          newTitle,
          requestingUser.role,
        );
      }
      await this.staffValidator.validateUniqueCanonicalTitle(school.id, newTitle, target.id);
    }

    const toStaff = dto.accessTier === AdminAccessTier.STAFF;
    const replacement = toStaff
      ? await this.resolveReplacementAccess(school.id, dto)
      : null;

    await this.prisma.$transaction(async (tx) => {
      await tx.schoolAdmin.update({
        where: { id: target.id },
        data: {
          accessTier: dto.accessTier,
          ...(newTitle ? { role: this.normalizeRoleName(newTitle) } : {}),
          ...(replacement
            ? {
                roleTemplateId: replacement.roleTemplateId,
                templateCustomised: replacement.customised,
              }
            // Promotion: a principal is not described by "Bursar access" any
            // more, so drop the link rather than leave a role that no longer
            // says anything true about what they can reach.
            : { roleTemplateId: null, templateCustomised: false }),
        },
      });

      if (!replacement) return;

      // Replace, not merge: the school named the access this person should have.
      await tx.staffPermission.deleteMany({ where: { adminId: target.id } });
      if (replacement.permissionIds.length > 0) {
        await tx.staffPermission.createMany({
          data: replacement.permissionIds.map((permissionId) => ({
            adminId: target.id,
            permissionId,
          })),
          skipDuplicates: true,
        });
      }
    });

    this.logger.log(
      `[changeAccessTier] ${target.id} moved to ${dto.accessTier}` +
        (replacement ? ` with ${replacement.permissionIds.length} permission rows` : ''),
    );
  }

  /**
   * Work out the exact permission rows a demoted admin should land on.
   *
   * Accepts either a named template or an explicit list, and insists on one of
   * them: "demote" with nothing said is the silent-lockout bug this replaces.
   * An empty list is allowed, because a school may genuinely want to park an
   * account — but it has to ask for that in so many words.
   */
  private async resolveReplacementAccess(
    schoolId: string,
    dto: { permissions?: Array<{ resource: PermissionResource; type: PermissionType }>; roleTemplateId?: string },
  ): Promise<{ permissionIds: string[]; roleTemplateId: string | null; customised: boolean }> {
    if (dto.roleTemplateId) {
      return {
        permissionIds: await this.roleTemplates.permissionIdsForTemplate(
          schoolId,
          dto.roleTemplateId,
        ),
        roleTemplateId: dto.roleTemplateId,
        customised: false,
      };
    }

    if (!Array.isArray(dto.permissions)) {
      throw new BadRequestException(
        'Removing principal-level access needs the access this person should keep. ' +
          'Send a role template or an explicit permission list.',
      );
    }

    return {
      permissionIds: await this.permissionIdsFor(dto.permissions),
      roleTemplateId: null,
      customised: false,
    };
  }

  /** Resolve resource/type pairs to catalog ids, bootstrapping the catalog if empty. */
  private async permissionIdsFor(
    permissions: Array<{ resource: PermissionResource; type: PermissionType }>,
  ): Promise<string[]> {
    if (permissions.length === 0) return [];

    const conditions = permissions.map((p) => ({
      resource: p.resource as PermissionResource,
      type: p.type as PermissionType,
    }));

    let rows = await this.prisma.permission.findMany({ where: { OR: conditions } });
    if (rows.length === 0) {
      await this.initializePermissions();
      rows = await this.prisma.permission.findMany({ where: { OR: conditions } });
    }
    return rows.map((row) => row.id);
  }

  /**
   * Make an admin the principal (switches current principal to admin)
   *
   * The incumbent's demotion goes through changeAccessTier, so they land on a
   * named replacement set instead of the zero rows the old title swap left.
   */
  async makePrincipal(
    schoolId: string,
    adminId: string,
    dto: MakePrincipalDto,
    requestingUser: UserWithContext,
  ): Promise<void> {
    // Validate school exists
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    // Role check: Only school owner can promote someone to principal
    const requestingAdmin = await this.prisma.schoolAdmin.findFirst({
      where: { userId: requestingUser.id, schoolId: school.id },
      select: { id: true, role: true, accessTier: true },
    });

    if (!isSchoolOwnerRole(requestingAdmin?.role)) {
      throw new ForbiddenException('Only the school owner can promote an administrator to principal');
    }

    // Validate admin exists in school
    const adminToPromote = await this.staffRepository.findAdminById(adminId);
    if (!adminToPromote || adminToPromote.schoolId !== school.id) {
      throw new BadRequestException('Administrator not found in this school');
    }

    if (hasPrincipalAccess(adminToPromote)) {
      throw new BadRequestException('This administrator already has a principal-level role');
    }

    // The sitting Principal, if there is one. The owner is excluded: promoting a
    // deputy must never unseat the person who owns the school — the old code
    // demoted every principal-level admin, owner included.
    const incumbents = await this.prisma.schoolAdmin.findMany({
      where: {
        schoolId: school.id,
        accessTier: AdminAccessTier.PRINCIPAL,
        id: { not: adminId },
      },
      select: { id: true, role: true },
    });
    const toDemote = incumbents.filter((admin) => !isSchoolOwnerRole(admin.role));

    if (toDemote.length > 0 && !dto?.incumbentRoleTemplateId && !Array.isArray(dto?.incumbentPermissions)) {
      throw new BadRequestException(
        'This school already has a principal. Say what access they should keep ' +
          'once they step down, or they will be left with an empty dashboard.',
      );
    }

    const replacement =
      toDemote.length > 0
        ? await this.resolveReplacementAccess(school.id, {
            permissions: dto?.incumbentPermissions,
            roleTemplateId: dto?.incumbentRoleTemplateId,
          })
        : null;

    await this.prisma.$transaction(async (tx) => {
      for (const outgoing of toDemote) {
        await tx.schoolAdmin.update({
          where: { id: outgoing.id },
          data: {
            accessTier: AdminAccessTier.STAFF,
            role: 'administrator',
            roleTemplateId: replacement!.roleTemplateId,
            templateCustomised: replacement!.customised,
          },
        });
        await tx.staffPermission.deleteMany({ where: { adminId: outgoing.id } });
        if (replacement!.permissionIds.length > 0) {
          await tx.staffPermission.createMany({
            data: replacement!.permissionIds.map((permissionId) => ({
              adminId: outgoing.id,
              permissionId,
            })),
            skipDuplicates: true,
          });
        }
      }

      // Promote selected admin: the tier is what grants access, the title follows.
      await tx.schoolAdmin.update({
        where: { id: adminId },
        data: { accessTier: AdminAccessTier.PRINCIPAL, role: 'principal' },
      });
    });
  }

  /**
   * Update a principal
   */
  async updatePrincipal(
    schoolId: string,
    principalId: string,
    updateData: { firstName?: string; lastName?: string; phone?: string }
  ): Promise<any> {
    // Validate school exists
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    // Find principal - use centralized function to check role
    const principal = await this.prisma.schoolAdmin.findFirst({
      where: {
        id: principalId,
        schoolId: school.id,
      },
    });

    if (!principal || !hasPrincipalAccess(principal)) {
      throw new BadRequestException('Principal not found in this school');
    }

    // Update principal
    const updatedPrincipal = await this.staffRepository.updateAdmin(principalId, {
      firstName: updateData.firstName,
      lastName: updateData.lastName,
      phone: updateData.phone,
    });

    return this.staffMapper.toAdminDto(updatedPrincipal);
  }

  /**
   * Delete a principal
   */
  async deletePrincipal(schoolId: string, principalId: string): Promise<void> {
    // Validate school exists
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    // Find principal - use centralized function to check role
    const principal = await this.prisma.schoolAdmin.findFirst({
      where: {
        id: principalId,
        schoolId: school.id,
      },
      include: { user: true },
    });

    if (!principal || !hasPrincipalAccess(principal)) {
      throw new BadRequestException('Principal not found in this school');
    }

    // Check if principal is active
    const isPrincipalActive = school.isActive && principal.user?.accountStatus === 'ACTIVE';

    if (isPrincipalActive) {
      throw new BadRequestException(
        'Cannot delete an active principal. You must first transfer the principal role to another administrator before deletion.'
      );
    }

    // Check for other admins
    const otherAdmins = await this.staffRepository.findAdminsBySchool(school.id);
    const nonPrincipalAdmins = otherAdmins.filter(
      (a) => a.id !== principalId && !hasPrincipalAccess(a)
    );

    if (nonPrincipalAdmins.length === 0) {
      throw new BadRequestException(
        'Cannot delete principal. There must be at least one other administrator to assign the principal role to before deletion.'
      );
    }

    await this.staffRepository.deleteAdmin(principalId);
  }

  /**
   * Convert a teacher to an admin
   */
  async convertTeacherToAdmin(
    schoolId: string,
    teacherId: string,
    role: string,
    keepAsTeacher: boolean,
    requestingUser: UserWithContext
  ): Promise<void> {
    // Validate school exists
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    // Check admin limit based on subscription tier
    const adminLimit = await this.subscriptionsService.checkAdminLimit(school.id);
    if (!adminLimit.canAdd) {
      throw new ForbiddenException(adminLimit.message);
    }

    // Validate teacher exists
    const teacher = await this.staffRepository.findTeacherById(teacherId);
    if (!teacher || teacher.schoolId !== school.id) {
      throw new BadRequestException('Teacher not found in this school');
    }

    // Check if already an admin in this school
    const existingAdmin = await this.prisma.schoolAdmin.findFirst({
      where: { userId: teacher.userId, schoolId: school.id },
    });

    if (existingAdmin) {
      throw new BadRequestException('This teacher is already an administrator in this school');
    }

    const sanitizedRole = role?.trim() || '';

    // Conversion never promotes. It mints a STAFF-tier admin even under a
    // principal-sounding title; use make-principal to grant the tier deliberately.
    const usesPrincipalTitle = isPrincipalRole(sanitizedRole);

    if (usesPrincipalTitle) {
      const requestingAdmin = await this.prisma.schoolAdmin.findFirst({
        where: { userId: requestingUser.id, schoolId: school.id },
      });

      if (!requestingAdmin && requestingUser.role !== 'SUPER_ADMIN') {
        throw new ForbiddenException('You do not have an admin profile in this school');
      }

      this.staffValidator.assertCanAssignPrincipalTitle(
        requestingAdmin?.role,
        sanitizedRole,
        requestingUser.role,
      );

      await this.staffValidator.validateUniqueCanonicalTitle(school.id, sanitizedRole);
    }

    const createdAdmin = await this.prisma.$transaction(async (tx) => {
      const adminId = usesPrincipalTitle
        ? await this.idGenerator.generatePrincipalId()
        : await this.idGenerator.generateAdminId();
      const publicId = await this.idGenerator.generatePublicId(school.name, 'admin');

      const newAdmin = await tx.schoolAdmin.create({
        data: {
          adminId,
          publicId,
          userId: teacher.userId,
          schoolId: school.id,
          firstName: teacher.firstName,
          lastName: teacher.lastName,
          email: teacher.email,
          phone: teacher.phone,
          role: this.normalizeRoleName(sanitizedRole),
          accessTier: AdminAccessTier.STAFF,
        },
      });

      await tx.user.update({
        where: { id: teacher.userId },
        data: { role: 'SCHOOL_ADMIN' },
      });

      if (!keepAsTeacher) {
        await tx.teacher.delete({
          where: { id: teacherId },
        });
      }

      return newAdmin;
    });

    // Unlike the Add Admin form, this path has no access step to fill in — it is
    // a super-admin provisioning action on an existing teacher. Read-everything
    // is the safe landing here, because zero rows would be a locked-out account.
    try {
      await this.assignDefaultReadPermissions(createdAdmin.id);
    } catch (error) {
      this.logger.error(
        'Failed to assign default permissions on teacher conversion:',
        error instanceof Error ? error.stack : error
      );
    }
  }

  /**
   * Get an admin by ID
   */
  async getAdminById(schoolId: string, adminId: string): Promise<any | null> {
    const admin = await this.staffRepository.findAdminById(adminId);
    if (!admin || admin.schoolId !== schoolId) {
      return null;
    }
    return this.staffMapper.toAdminDto(admin);
  }

  /**
   * Upload admin profile image
   */
  async uploadProfileImage(
    schoolId: string,
    adminId: string,
    file: Express.Multer.File
  ): Promise<any> {
    // Validate school exists
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    // Validate admin exists in school
    const admin = await this.staffRepository.findAdminById(adminId);
    if (!admin || admin.schoolId !== school.id) {
      throw new NotFoundException('Admin not found in this school');
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
    if (admin.profileImage) {
      const oldPublicId = this.cloudinaryService.extractPublicId(admin.profileImage);
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
      `schools/${schoolId}/staff/admins`,
      `admin-${adminId}`
    );

    // Update admin with new image URL
    const updatedAdmin = await this.staffRepository.updateAdmin(adminId, {
      profileImage: url,
    });

    return this.staffMapper.toAdminDto(updatedAdmin);
  }

  /**
   * Assign default READ permissions to a new admin
   * This ensures new admins can at least view all dashboard screens
   */
  private async assignDefaultReadPermissions(adminId: string): Promise<void> {
    this.logger.log(`[assignDefaultReadPermissions] Starting for admin ${adminId}`);

    // Get all READ permissions
    let readPermissions = await this.prisma.permission.findMany({
      where: {
        type: PermissionType.READ,
      },
    });

    this.logger.log(
      `[assignDefaultReadPermissions] Found ${readPermissions.length} READ permissions in database`
    );

    if (readPermissions.length === 0) {
      this.logger.warn(
        '[assignDefaultReadPermissions] No READ permissions found in database! Initializing...'
      );
      await this.initializePermissions();

      // Try again
      readPermissions = await this.prisma.permission.findMany({
        where: { type: PermissionType.READ },
      });

      if (readPermissions.length === 0) {
        this.logger.error(
          '[assignDefaultReadPermissions] Still no permissions after initialization!'
        );
        return;
      }
    }

    // Assign all READ permissions to the admin
    const result = await this.prisma.staffPermission.createMany({
      data: readPermissions.map((perm) => ({
        adminId: adminId,
        permissionId: perm.id,
      })),
      skipDuplicates: true,
    });

    this.logger.log(
      `[assignDefaultReadPermissions] Created ${result.count} permission assignments for admin ${adminId}`
    );
  }


  /**
   * Initialize permissions in the database
   */
  private async initializePermissions(): Promise<void> {
    const resources = Object.values(PermissionResource);
    const types = Object.values(PermissionType);

    this.logger.log(
      `[initializePermissions] Creating ${resources.length * types.length} permissions...`
    );

    for (const resource of resources) {
      for (const type of types) {
        await this.prisma.permission.upsert({
          where: {
            resource_type: {
              resource: resource,
              type: type,
            },
          },
          create: {
            resource: resource,
            type: type,
            description: `${type} access to ${resource}`,
          },
          update: {},
        });
      }
    }

    this.logger.log(`[initializePermissions] Done`);
  }

  /**
   * Helper: Normalize role name to use underscores for multi-word roles
   * This ensures consistency with PRINCIPAL_ROLES array
   */
  private normalizeRoleName(role: string): string {
    if (!role) return 'administrator';

    // Trim and normalize
    const normalized = role.trim();

    // If it's already a principal role (case-insensitive), return the canonical form
    if (isPrincipalRole(normalized)) {
      return canonicalizeUniqueTitle(normalized);
    }

    // For non-principal roles, replace spaces with underscores and lowercase
    return normalized.toLowerCase().replace(/\s+/g, '_');
  }
}
