import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  OnModuleInit,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { EmailService } from '../../../email/email.service';
import {
  PermissionDto,
  PermissionResource,
  PermissionType,
  StaffPermissionsDto,
  hasPrincipalAccess,
} from '../../dto/permission.dto';
import { UserWithContext } from '../../../auth/types/user-with-context.type';
import { BUILT_IN_ROLE_TEMPLATES } from './built-in-role-templates';

@Injectable()
export class PermissionService implements OnModuleInit {
  private readonly logger = new Logger(PermissionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService
  ) { }

  async onModuleInit() {
    // Initialize default permissions on module startup
    await this.initializeDefaultPermissions();
    // Built-in templates reference permission ids, so they must follow the catalog.
    await this.initializeBuiltInRoleTemplates();
  }

  /**
   * Seed the platform's built-in access bundles (schoolId null).
   *
   * Keyed on `slug`, so wording can be improved without duplicating rows, and
   * re-running is harmless. Permission sets are refreshed on every boot: a
   * built-in is ours to correct, and a school that has customised its copy of
   * the access is unaffected, because applying a template copies rows rather
   * than linking to them.
   */
  async initializeBuiltInRoleTemplates(): Promise<void> {
    const catalog = await this.prisma.permission.findMany({
      select: { id: true, resource: true, type: true },
    });
    if (catalog.length === 0) {
      this.logger.warn('No permissions in catalog; skipping built-in role templates.');
      return;
    }

    const idFor = new Map(catalog.map((p) => [`${p.resource}:${p.type}`, p.id]));

    for (const template of BUILT_IN_ROLE_TEMPLATES) {
      const permissionIds: string[] = [];
      for (const wanted of template.permissions) {
        const id = idFor.get(`${wanted.resource}:${wanted.type}`);
        if (!id) {
          this.logger.warn(
            `Built-in template "${template.slug}" wants ${wanted.resource}:${wanted.type}, which is not in the catalog.`,
          );
          continue;
        }
        permissionIds.push(id);
      }

      const existing = await this.prisma.roleTemplate.findFirst({
        where: { schoolId: null, slug: template.slug },
        select: { id: true },
      });

      if (existing) {
        await this.prisma.roleTemplate.update({
          where: { id: existing.id },
          data: {
            name: template.name,
            description: template.description,
            suggestedRole: template.suggestedRole,
            permissionIds,
            isSystem: true,
          },
        });
        continue;
      }

      await this.prisma.roleTemplate.create({
        data: {
          schoolId: null,
          slug: template.slug,
          name: template.name,
          description: template.description,
          suggestedRole: template.suggestedRole,
          permissionIds,
          isSystem: true,
        },
      });
    }

    this.logger.log(`Built-in role templates ready (${BUILT_IN_ROLE_TEMPLATES.length}).`);
  }

  /**
   * Get all available permissions
   */
  async getAllPermissions(): Promise<PermissionDto[]> {
    const permissions = await this.prisma.permission.findMany({
      orderBy: [{ resource: 'asc' }, { type: 'asc' }],
    });

    return permissions.map((p) => ({
      id: p.id,
      resource: p.resource as PermissionResource,
      type: p.type as PermissionType,
      description: p.description || undefined,
    }));
  }

  /**
   * Get permissions for a specific admin
   */
  async getAdminPermissions(schoolId: string, adminId: string): Promise<StaffPermissionsDto> {
    const admin = await this.prisma.schoolAdmin.findFirst({
      where: {
        id: adminId,
        schoolId: schoolId,
      },
      include: {
        permissions: {
          include: {
            permission: true,
          },
        },
      },
    });

    if (!admin) {
      throw new NotFoundException('Admin not found');
    }

    return {
      adminId: admin.id,
      adminName: `${admin.firstName} ${admin.lastName}`,
      role: admin.role,
      // The UI must not re-derive authority from the title, so hand it the tier.
      accessTier: admin.accessTier,
      permissions: admin.permissions.map((sp) => ({
        id: sp.permission.id,
        resource: sp.permission.resource as PermissionResource,
        type: sp.permission.type as PermissionType,
        description: sp.permission.description || undefined,
      })),
    };
  }

  /**
   * Assign permissions to an admin
   * Note: Principal permissions cannot be modified - they have permanent full access
   *
   * @param schoolId - The school ID
   * @param adminId - The target admin's ID
   * @param permissionIds - Array of permission IDs to assign
   * @param callerUser - The user making the request (for IDOR protection and audit)
   * @param callerIp - The IP address of the caller (for audit logging)
   */
  async assignPermissions(
    schoolId: string,
    adminId: string,
    permissionIds: string[],
    callerUser?: UserWithContext,
    callerIp?: string
  ): Promise<StaffPermissionsDto> {
    // Verify target admin exists
    const targetAdmin = await this.prisma.schoolAdmin.findFirst({
      where: {
        id: adminId,
        schoolId: schoolId,
      },
    });

    if (!targetAdmin) {
      throw new NotFoundException('Admin not found');
    }

    // Prevent modifying Principal permissions - they have permanent full access
    if (hasPrincipalAccess(targetAdmin)) {
      throw new BadRequestException(
        'Principal permissions cannot be modified. Principals have permanent full access to all school resources.'
      );
    }

    // IDOR Protection: Verify caller has authority to modify target's permissions
    if (callerUser && callerUser.role === 'SCHOOL_ADMIN') {
      const callerAdmin = await this.prisma.schoolAdmin.findFirst({
        where: {
          userId: callerUser.id,
          schoolId: schoolId,
        },
        include: {
          permissions: {
            include: { permission: true },
          },
        },
      });

      if (!callerAdmin) {
        throw new ForbiddenException('You do not have access to this school');
      }

      // Principals can modify anyone's permissions
      const callerIsPrincipal = hasPrincipalAccess(callerAdmin);

      if (!callerIsPrincipal) {
        throw new ForbiddenException(
          "Only Principal-level administrators can assign or modify permissions."
        );
      }
    }

    // Verify all permissions exist
    const permissions = await this.prisma.permission.findMany({
      where: {
        id: { in: permissionIds },
      },
    });

    if (permissions.length !== permissionIds.length) {
      throw new BadRequestException('One or more permissions not found');
    }

    // Get current permissions for audit log (before change)
    const previousPermissions = await this.prisma.staffPermission.findMany({
      where: { adminId: adminId },
      include: { permission: true },
    });

    // Get school name for email
    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
      select: { name: true },
    });

    // Remove existing permissions and assign new ones
    await this.prisma.$transaction(async (tx) => {
      // Delete existing permissions
      await tx.staffPermission.deleteMany({
        where: {
          adminId: adminId,
        },
      });

      // Create new permissions
      if (permissionIds.length > 0) {
        await tx.staffPermission.createMany({
          data: permissionIds.map((permId) => ({
            adminId: adminId,
            permissionId: permId,
          })),
        });
      }

      // A hand-edit is drift from whatever role they were given. Recording it
      // lets "re-apply this role" skip them, so a deliberate exception is not
      // quietly erased the next time someone corrects the role.
      if (targetAdmin.roleTemplateId) {
        await tx.schoolAdmin.update({
          where: { id: adminId },
          data: { templateCustomised: true },
        });
      }
    });

    // Get updated permissions with details
    const updatedPermissions = await this.getAdminPermissions(schoolId, adminId);

    // Audit logging
    const previousPermIds = previousPermissions.map((p) => p.permission.id).sort();
    const newPermIds = permissionIds.sort();
    const added = permissionIds.filter((id) => !previousPermIds.includes(id));
    const removed = previousPermIds.filter((id) => !newPermIds.includes(id));

    this.logger.log({
      event: 'PERMISSION_CHANGE',
      timestamp: new Date().toISOString(),
      schoolId,
      targetAdminId: adminId,
      targetAdminName: `${targetAdmin.firstName} ${targetAdmin.lastName}`,
      targetAdminRole: targetAdmin.role,
      callerUserId: callerUser?.id || 'system',
      callerIp: callerIp || 'unknown',
      previousPermissionCount: previousPermissions.length,
      newPermissionCount: permissionIds.length,
      permissionsAdded: added.length,
      permissionsRemoved: removed.length,
      addedPermissionIds: added,
      removedPermissionIds: removed,
    });

    // Send email to admin if email exists
    if (targetAdmin.email && school && updatedPermissions.permissions.length > 0) {
      try {
        await this.emailService.sendPermissionAssignmentEmail(
          targetAdmin.email,
          `${targetAdmin.firstName} ${targetAdmin.lastName}`,
          updatedPermissions.permissions.map((p) => ({
            resource: p.resource,
            type: p.type,
            description: p.description,
          })),
          school.name
        );
      } catch (error) {
        this.logger.error('Failed to send permission assignment email:', error);
      }
    }

    return updatedPermissions;
  }

  /**
   * Check if admin has a specific permission
   */
  async hasPermission(
    adminId: string,
    resource: PermissionResource,
    type: PermissionType
  ): Promise<boolean> {
    // Check if admin has ADMIN permission (full access)
    const hasAdmin = await this.prisma.staffPermission.findFirst({
      where: {
        adminId: adminId,
        permission: {
          resource: resource,
          type: PermissionType.ADMIN,
        },
      },
    });

    if (hasAdmin) {
      return true; // ADMIN permission grants all access
    }

    // Check for specific permission
    const permission = await this.prisma.staffPermission.findFirst({
      where: {
        adminId: adminId,
        permission: {
          resource: resource,
          type: type,
        },
      },
    });

    return !!permission;
  }

  /**
   * Check if admin has admin permission (full access like principal)
   */
  async hasAdminPermission(adminId: string, resource: PermissionResource): Promise<boolean> {
    return this.hasPermission(adminId, resource, PermissionType.ADMIN);
  }

  /**
   * Initialize default permissions in the database
   * This should be called during app startup or migration
   */
  async initializeDefaultPermissions(): Promise<void> {
    const resources = Object.values(PermissionResource);
    const types = Object.values(PermissionType);

    // Production Hardening: Check if permissions are already initialized to avoid massive upsert loops on boot
    const count = await this.prisma.permission.count();
    const expectedCount = resources.length * types.length;

    if (count >= expectedCount) {
      this.logger.log(`Permissions already initialized (${count}/${expectedCount}). Skipping setup.`);
      return;
    }

    this.logger.log(`Initial Setup: Initializing ${expectedCount} default permissions...`);

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
            description: this.getPermissionDescription(resource, type),
          },
          update: {},
        });
      }
    }
  }

  private getPermissionDescription(resource: PermissionResource, type: PermissionType): string {
    const resourceNames: Record<PermissionResource, string> = {
      OVERVIEW: 'Dashboard Overview',
      ANALYTICS: 'Analytics',
      SUBSCRIPTIONS: 'Subscriptions',
      STUDENTS: 'Students',
      STAFF: 'Staff',
      CLASSES: 'Classes',
      SUBJECTS: 'Subjects',
      TIMETABLES: 'Timetables',
      CALENDAR: 'Calendar',
      ADMISSIONS: 'Admissions',
      SESSIONS: 'Sessions',
      EVENTS: 'Events',
      GRADES: 'Grades',
      CURRICULUM: 'Curriculum',
      SCHEME_OF_WORK: 'Scheme of Work',
      RESOURCES: 'Class Resources',
      TRANSFERS: 'Student Transfers',
      INTEGRATIONS: 'External Integrations',
      SETTINGS: 'School Settings',
    };

    const typeNames: Record<PermissionType, string> = {
      READ: 'Read',
      WRITE: 'Write',
      ADMIN: 'Admin',
    };

    return `${typeNames[type]} access to ${resourceNames[resource]}`;
  }

  /**
   * Migrate existing admins by assigning default READ permissions
   * This is for backward compatibility with accounts created before the permission system
   * Skips Principals (they have permanent full access) and admins who already have permissions
   */
  async migrateExistingAdmins(schoolId: string): Promise<{ migrated: number; skipped: number }> {
    // Get all READ permissions
    const readPermissions = await this.prisma.permission.findMany({
      where: { type: PermissionType.READ },
    });

    if (readPermissions.length === 0) {
      throw new BadRequestException(
        'No READ permissions found. Please initialize permissions first.'
      );
    }

    // Get all admins for this school
    const admins = await this.prisma.schoolAdmin.findMany({
      where: { schoolId },
      include: {
        permissions: true,
      },
    });

    let migrated = 0;
    let skipped = 0;

    for (const admin of admins) {
      // Skip principals - they have permanent full access
      if (hasPrincipalAccess(admin)) {
        skipped++;
        continue;
      }

      // Skip admins who already have permissions
      if (admin.permissions.length > 0) {
        skipped++;
        continue;
      }

      // Assign default READ permissions
      await this.prisma.staffPermission.createMany({
        data: readPermissions.map((perm) => ({
          adminId: admin.id,
          permissionId: perm.id,
        })),
        skipDuplicates: true,
      });

      migrated++;
    }

    return { migrated, skipped };
  }
}
