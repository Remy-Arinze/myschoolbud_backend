import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AdminAccessTier } from '@prisma/client';
import { PermissionGuard } from './permission.guard';
import { PERMISSION_KEY } from '../decorators/permission.decorator';
import { PermissionResource, PermissionType } from '../../schools/dto/permission.dto';

/**
 * The guard is where every admin request is actually allowed or refused, and it
 * had no direct spec. Two things matter here and are easy to break silently:
 * the tier bypass, and the READ < WRITE < ADMIN hierarchy — a school that
 * grants Full Control expects the person to be able to view the screen too.
 */
describe('PermissionGuard', () => {
  const schoolAdmin = { findFirst: jest.fn() };
  const staffPermission = { findFirst: jest.fn() };
  const prisma = { schoolAdmin, staffPermission };

  const reflector = { get: jest.fn() };
  const guard = new PermissionGuard(reflector as never, prisma as never);

  const contextFor = (user: unknown, schoolId = 'school-1') =>
    ({
      getHandler: () => () => undefined,
      switchToHttp: () => ({ getRequest: () => ({ user, schoolId }) }),
    }) as unknown as ExecutionContext;

  const admin = { id: 'user-1', role: 'SCHOOL_ADMIN' };

  /** Rows the admin holds, as the guard would find them. */
  const holding = (...types: PermissionType[]) => {
    staffPermission.findFirst.mockImplementation(async ({ where }: { where?: any }) => {
      const wanted = where?.permission?.type;
      const candidates: PermissionType[] = wanted?.in ? wanted.in : [wanted];
      const hit = candidates.find((type) => types.includes(type));
      return hit ? { id: `row-${hit}` } : null;
    });
  };

  beforeEach(() => {
    jest.clearAllMocks();
    reflector.get.mockReturnValue({
      resource: PermissionResource.CLASSES,
      type: PermissionType.READ,
    });
    schoolAdmin.findFirst.mockResolvedValue({
      id: 'admin-1',
      accessTier: AdminAccessTier.STAFF,
    });
  });

  it('allows an unguarded handler through', async () => {
    reflector.get.mockReturnValue(undefined);
    await expect(guard.canActivate(contextFor(admin))).resolves.toBe(true);
    expect(schoolAdmin.findFirst).not.toHaveBeenCalled();
  });

  it('lets a principal-tier admin past without reading a single row', async () => {
    schoolAdmin.findFirst.mockResolvedValue({
      id: 'admin-1',
      accessTier: AdminAccessTier.PRINCIPAL,
    });
    reflector.get.mockReturnValue({
      resource: PermissionResource.SUBSCRIPTIONS,
      type: PermissionType.ADMIN,
    });

    await expect(guard.canActivate(contextFor(admin))).resolves.toBe(true);
    expect(staffPermission.findFirst).not.toHaveBeenCalled();
  });

  it('only selects the tier — it must not be able to read the title', async () => {
    await guard.canActivate(contextFor(admin)).catch(() => undefined);

    expect(schoolAdmin.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ select: { id: true, accessTier: true } }),
    );
  });

  describe('READ < WRITE < ADMIN', () => {
    const require = (type: PermissionType) =>
      reflector.get.mockReturnValue({ resource: PermissionResource.CLASSES, type });

    it('satisfies READ with a READ row', async () => {
      require(PermissionType.READ);
      holding(PermissionType.READ);
      await expect(guard.canActivate(contextFor(admin))).resolves.toBe(true);
    });

    it('satisfies READ with only a WRITE row', async () => {
      require(PermissionType.READ);
      holding(PermissionType.WRITE);
      await expect(guard.canActivate(contextFor(admin))).resolves.toBe(true);
    });

    // The gap the E2E suite never covered: both pickers cascade ADMIN down into
    // WRITE and READ, so a hand-written ADMIN-only grant is the only way this
    // path gets exercised.
    it('satisfies READ with only an ADMIN row', async () => {
      require(PermissionType.READ);
      holding(PermissionType.ADMIN);
      await expect(guard.canActivate(contextFor(admin))).resolves.toBe(true);
    });

    it('satisfies WRITE with only an ADMIN row', async () => {
      require(PermissionType.WRITE);
      holding(PermissionType.ADMIN);
      await expect(guard.canActivate(contextFor(admin))).resolves.toBe(true);
    });

    it('does not satisfy WRITE with only a READ row', async () => {
      require(PermissionType.WRITE);
      holding(PermissionType.READ);
      await expect(guard.canActivate(contextFor(admin))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('does not satisfy ADMIN with READ and WRITE rows', async () => {
      require(PermissionType.ADMIN);
      holding(PermissionType.READ, PermissionType.WRITE);
      await expect(guard.canActivate(contextFor(admin))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('keeps levels per-resource: Students access does not open Classes', async () => {
      require(PermissionType.READ);
      staffPermission.findFirst.mockImplementation(async ({ where }: { where?: any }) =>
        where?.permission?.resource === PermissionResource.STUDENTS ? { id: 'row' } : null,
      );
      await expect(guard.canActivate(contextFor(admin))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('names the resource and level when it refuses', async () => {
      require(PermissionType.WRITE);
      holding();
      await expect(guard.canActivate(contextFor(admin))).rejects.toThrow(/WRITE.*CLASSES/);
    });
  });

  it('refuses an admin with no rows at all', async () => {
    holding();
    await expect(guard.canActivate(contextFor(admin))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses when the admin has no profile in this school', async () => {
    schoolAdmin.findFirst.mockResolvedValue(null);
    await expect(guard.canActivate(contextFor(admin))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses without a school context rather than guessing one', async () => {
    await expect(
      guard.canActivate(contextFor({ ...admin, currentSchoolId: undefined }, undefined as never)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets super admins through', async () => {
    await expect(
      guard.canActivate(contextFor({ id: 'u', role: 'SUPER_ADMIN' })),
    ).resolves.toBe(true);
  });

  it('leaves teachers and students to their own service-level checks', async () => {
    await expect(guard.canActivate(contextFor({ id: 'u', role: 'TEACHER' }))).resolves.toBe(true);
    await expect(guard.canActivate(contextFor({ id: 'u', role: 'STUDENT' }))).resolves.toBe(true);
  });

  it('denies unknown roles by default', async () => {
    await expect(
      guard.canActivate(contextFor({ id: 'u', role: 'GUEST' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('is keyed by the decorator the routes use', () => {
    expect(PERMISSION_KEY).toBeTruthy();
  });
});
