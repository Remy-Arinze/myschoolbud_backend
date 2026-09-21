import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../database/prisma.service';
import { UserWithContext } from '../../auth/types/user-with-context.type';
import { PERMISSION_KEY } from '../decorators/permission.decorator';
import {
  PermissionResource,
  PermissionType,
  hasPrincipalAccess,
} from '../../schools/dto/permission.dto';

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredPermission = this.reflector.get<{
      resource: PermissionResource;
      type: PermissionType;
    }>(PERMISSION_KEY, context.getHandler());

    // If no permission required, allow access
    if (!requiredPermission) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user: UserWithContext = request.user;

    // Super admin has all permissions
    if (user.role === 'SUPER_ADMIN') {
      return true;
    }

    // For school admins, check permissions
    if (user.role === 'SCHOOL_ADMIN') {
      const schoolId = request.schoolId || user.currentSchoolId;

      if (!schoolId) {
        throw new ForbiddenException('School context required');
      }

      // Find the admin profile
      const admin = await this.prisma.schoolAdmin.findFirst({
        where: {
          userId: user.id,
          schoolId: schoolId,
        },
        select: { id: true, accessTier: true },
      });

      if (!admin) {
        throw new ForbiddenException('Admin profile not found');
      }

      // Principal-tier admins bypass the permission tables. Read the stored
      // tier, never the title — a typed title must not decide authority.
      if (hasPrincipalAccess(admin)) {
        return true;
      }

      // Check if admin has ADMIN permission (full access)
      const hasAdminPermission = await this.prisma.staffPermission.findFirst({
        where: {
          adminId: admin.id,
          permission: {
            resource: requiredPermission.resource,
            type: PermissionType.ADMIN,
          },
        },
      });

      if (hasAdminPermission) {
        return true; // ADMIN permission grants all access
      }

      // Determine hierarchical allowed permission types
      const allowedTypes: PermissionType[] = [PermissionType.ADMIN];
      if (requiredPermission.type === PermissionType.WRITE) {
        allowedTypes.push(PermissionType.WRITE);
      } else if (requiredPermission.type === PermissionType.READ) {
        allowedTypes.push(PermissionType.WRITE, PermissionType.READ);
      }

      // Check for hierarchical permissions (e.g. if WRITE is required, user having ADMIN passes; if READ is required, user having WRITE or ADMIN passes)
      const hasPermission = await this.prisma.staffPermission.findFirst({
        where: {
          adminId: admin.id,
          permission: {
            resource: requiredPermission.resource,
            type: { in: allowedTypes },
          },
        },
      });

      if (!hasPermission) {
        throw new ForbiddenException(
          `You do not have ${requiredPermission.type} permission for ${requiredPermission.resource}`
        );
      }

      return true;
    }

    // TEACHER role: Teachers have their own authorization logic in services
    // They don't use the admin permission system
    if (user.role === 'TEACHER') {
      return true;
    }

    // STUDENT role: Students have their own access controls
    if (user.role === 'STUDENT') {
      return true;
    }

    // For other roles, deny by default
    throw new ForbiddenException('Permission denied');
  }
}
