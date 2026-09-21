import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AdminAccessTier } from '@prisma/client';
import { PermissionService } from './permission.service';
import { PermissionResource, PermissionType } from '../../dto/permission.dto';

/**
 * Permission assignment is the write path for everything an admin can reach,
 * and it had no unit coverage at all. These cover the three behaviours a school
 * would notice if they broke: it replaces rather than merges, it refuses to
 * pretend principal access comes from rows, and it will not let an admin
 * grant themselves anything.
 */
describe('PermissionService.assignPermissions', () => {
  const staffPermission = {
    deleteMany: jest.fn(),
    createMany: jest.fn(),
    findMany: jest.fn(),
  };
  const schoolAdmin = { findFirst: jest.fn(), update: jest.fn(), findMany: jest.fn() };
  const permission = { findMany: jest.fn(), count: jest.fn(), createMany: jest.fn() };
  const roleTemplate = { findMany: jest.fn(), upsert: jest.fn() };

  const prisma = {
    schoolAdmin,
    staffPermission,
    permission,
    roleTemplate,
    school: { findUnique: jest.fn().mockResolvedValue({ name: 'Beulah High' }) },
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) =>
      fn({ staffPermission, schoolAdmin }),
    ),
  };

  const emailService = { sendPermissionsAssignedEmail: jest.fn().mockResolvedValue(undefined) };

  const service = new PermissionService(prisma as never, emailService as never);

  const staffTarget = {
    id: 'admin-1',
    schoolId: 'school-1',
    firstName: 'Ada',
    lastName: 'Okoye',
    email: 'ada@example.com',
    role: 'Bursar',
    accessTier: AdminAccessTier.STAFF,
    roleTemplateId: null,
    // assignPermissions re-reads the admin through getAdminPermissions, which
    // includes the joined rows.
    permissions: [] as Array<{ permission: unknown }>,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    staffPermission.findMany.mockResolvedValue([]);
    schoolAdmin.findFirst.mockResolvedValue(staffTarget);
  });

  it('replaces the whole set rather than merging into it', async () => {
    permission.findMany.mockResolvedValue([{ id: 'p-new' }]);

    await service.assignPermissions('school-1', 'admin-1', ['p-new']);

    expect(staffPermission.deleteMany).toHaveBeenCalledWith({ where: { adminId: 'admin-1' } });
    expect(staffPermission.createMany).toHaveBeenCalledWith({
      data: [{ adminId: 'admin-1', permissionId: 'p-new' }],
    });
  });

  it('accepts an empty set as "no dashboard access" and still clears the old rows', async () => {
    permission.findMany.mockResolvedValue([]);

    await service.assignPermissions('school-1', 'admin-1', []);

    expect(staffPermission.deleteMany).toHaveBeenCalledWith({ where: { adminId: 'admin-1' } });
    expect(staffPermission.createMany).not.toHaveBeenCalled();
  });

  it('records drift when a role-holder is hand-edited, so re-apply can skip them', async () => {
    schoolAdmin.findFirst.mockResolvedValue({ ...staffTarget, roleTemplateId: 'tpl-bursar' });
    permission.findMany.mockResolvedValue([{ id: 'p-new' }]);

    await service.assignPermissions('school-1', 'admin-1', ['p-new']);

    expect(schoolAdmin.update).toHaveBeenCalledWith({
      where: { id: 'admin-1' },
      data: { templateCustomised: true },
    });
  });

  it('leaves templateCustomised alone for an admin who holds no role', async () => {
    permission.findMany.mockResolvedValue([{ id: 'p-new' }]);

    await service.assignPermissions('school-1', 'admin-1', ['p-new']);

    expect(schoolAdmin.update).not.toHaveBeenCalled();
  });

  it('refuses to write rows for a principal, whose access does not come from rows', async () => {
    schoolAdmin.findFirst.mockResolvedValue({
      ...staffTarget,
      accessTier: AdminAccessTier.PRINCIPAL,
    });

    await expect(service.assignPermissions('school-1', 'admin-1', ['p-new'])).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(staffPermission.deleteMany).not.toHaveBeenCalled();
  });

  it('does not treat a principal-sounding title as principal access', async () => {
    // Under the old string match this row bypassed everything. The tier says STAFF.
    schoolAdmin.findFirst.mockResolvedValue({
      ...staffTarget,
      role: 'Head Teacher',
      accessTier: AdminAccessTier.STAFF,
    });
    permission.findMany.mockResolvedValue([{ id: 'p-new' }]);

    await expect(
      service.assignPermissions('school-1', 'admin-1', ['p-new']),
    ).resolves.toBeDefined();
  });

  it('rejects a staff-tier caller trying to change anyone permissions', async () => {
    schoolAdmin.findFirst
      .mockResolvedValueOnce(staffTarget) // target
      .mockResolvedValueOnce({
        id: 'admin-2',
        accessTier: AdminAccessTier.STAFF,
        permissions: [],
      }); // caller

    await expect(
      service.assignPermissions('school-1', 'admin-1', ['p-new'], {
        id: 'user-2',
        role: 'SCHOOL_ADMIN',
      } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(staffPermission.deleteMany).not.toHaveBeenCalled();
  });

  it('allows a principal-tier caller', async () => {
    schoolAdmin.findFirst
      .mockResolvedValueOnce(staffTarget)
      .mockResolvedValueOnce({
        id: 'admin-2',
        accessTier: AdminAccessTier.PRINCIPAL,
        permissions: [],
      });
    permission.findMany.mockResolvedValue([{ id: 'p-new' }]);

    await expect(
      service.assignPermissions('school-1', 'admin-1', ['p-new'], {
        id: 'user-2',
        role: 'SCHOOL_ADMIN',
      } as never),
    ).resolves.toBeDefined();
  });

  it('rejects a caller with no admin profile in the school', async () => {
    schoolAdmin.findFirst.mockResolvedValueOnce(staffTarget).mockResolvedValueOnce(null);

    await expect(
      service.assignPermissions('school-1', 'admin-1', ['p-new'], {
        id: 'user-9',
        role: 'SCHOOL_ADMIN',
      } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects permission ids that are not in the catalog', async () => {
    permission.findMany.mockResolvedValue([{ id: 'p-a' }]);

    await expect(
      service.assignPermissions('school-1', 'admin-1', ['p-a', 'p-ghost']),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(staffPermission.deleteMany).not.toHaveBeenCalled();
  });

  it('rejects an admin from another school', async () => {
    schoolAdmin.findFirst.mockResolvedValue(null);

    await expect(
      service.assignPermissions('school-1', 'admin-elsewhere', ['p-new']),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('exposes the tier alongside the rows so the UI never string-matches a title', async () => {
    schoolAdmin.findFirst.mockResolvedValue({
      ...staffTarget,
      accessTier: AdminAccessTier.PRINCIPAL,
      permissions: [
        {
          permission: {
            id: 'p-1',
            resource: PermissionResource.STUDENTS,
            type: PermissionType.READ,
            description: null,
          },
        },
      ],
    });

    const result = await service.getAdminPermissions('school-1', 'admin-1');

    expect(result.accessTier).toBe(AdminAccessTier.PRINCIPAL);
    expect(result.permissions).toHaveLength(1);
  });
});
