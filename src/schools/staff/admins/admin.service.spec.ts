import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { AdminService } from './admin.service';
import { SchoolRepository } from '../../domain/repositories/school.repository';
import { StaffRepository } from '../../domain/repositories/staff.repository';
import { StaffMapper } from '../../domain/mappers/staff.mapper';
import { IdGeneratorService } from '../../shared/id-generator.service';
import { StaffValidatorService } from '../../shared/staff-validator.service';
import { PrismaService } from '../../../database/prisma.service';
import { AuthService } from '../../../auth/auth.service';
import { CloudinaryService } from '../../../storage/cloudinary/cloudinary.service';
import { SubscriptionsService } from '../../../subscriptions/subscriptions.service';
import { NotificationService } from '../../../notification/notification.service';
import { RoleTemplateService } from '../permissions/role-template.service';
import { TestUtils } from '../../../common/test/test-utils';
import { PermissionResource, PermissionType } from '../../dto/permission.dto';

describe('AdminService', () => {
  let service: AdminService;
  let schoolRepository: jest.Mocked<SchoolRepository>;
  let staffRepository: jest.Mocked<StaffRepository>;
  let staffMapper: jest.Mocked<StaffMapper>;
  let idGenerator: jest.Mocked<IdGeneratorService>;
  let staffValidator: jest.Mocked<StaffValidatorService>;
  let prisma: jest.Mocked<PrismaService>;
  let authService: jest.Mocked<AuthService>;
  let roleTemplates: jest.Mocked<RoleTemplateService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        {
          provide: SchoolRepository,
          useValue: {
            findById: jest.fn(),
          },
        },
        {
          provide: StaffRepository,
          useValue: {
            findAdminById: jest.fn(),
            createAdmin: jest.fn(),
            updateAdmin: jest.fn(),
            deleteAdmin: jest.fn(),
            findAdminsBySchool: jest.fn(),
          },
        },
        {
          provide: StaffMapper,
          useValue: {
            toAdminDto: jest.fn(),
          },
        },
        {
          provide: IdGeneratorService,
          useValue: {
            generateAdminId: jest.fn(),
            generatePrincipalId: jest.fn(),
            generatePublicId: jest.fn(),
          },
        },
        {
          provide: StaffValidatorService,
          useValue: {
            validateStaffData: jest.fn(),
            validateEmailUniqueInSchool: jest.fn(),
            validatePhoneUniqueInSchool: jest.fn(),
            validatePrincipalRole: jest.fn(),
            validateUniqueCanonicalTitle: jest.fn(),
            assertCanAssignPrincipalTitle: jest.fn(),
            assertCanGrantPrincipalTier: jest.fn(),
          },
        },
        {
          provide: PrismaService,
          useValue: {
            ...TestUtils.createMockPrismaService(),
            $transaction: jest.fn(async (callback) => {
              const mockTx = TestUtils.createMockPrismaService();
              return callback(mockTx as any);
            }),
          },
        },
        {
          provide: AuthService,
          useValue: {
            sendPasswordResetEmail: jest.fn(),
            sendPasswordResetForNewUser: jest.fn(),
          },
        },
        {
          provide: CloudinaryService,
          useValue: TestUtils.createMockCloudinaryService(),
        },
        {
          provide: SubscriptionsService,
          useValue: {
            checkAdminLimit: jest.fn().mockResolvedValue({ canAdd: true }),
          },
        },
        {
          provide: NotificationService,
          useValue: {
            notifySchoolAdmins: jest.fn(),
          },
        },
        {
          provide: RoleTemplateService,
          useValue: {
            permissionIdsForTemplate: jest.fn().mockResolvedValue(['perm-1']),
          },
        },
      ],
    }).compile();

    service = module.get<AdminService>(AdminService);
    schoolRepository = module.get(SchoolRepository);
    staffRepository = module.get(StaffRepository);
    staffMapper = module.get(StaffMapper);
    idGenerator = module.get(IdGeneratorService);
    staffValidator = module.get(StaffValidatorService);
    prisma = module.get(PrismaService);
    authService = module.get(AuthService);
    roleTemplates = module.get(RoleTemplateService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('addAdmin', () => {
    const mockSchool = { id: 'school-1', name: 'Test School' };
    // Access has to be stated on every create now, so the fixture states it.
    const mockAdminData = {
      firstName: 'John',
      lastName: 'Doe',
      email: 'john@example.com',
      phone: '+1234567890',
      role: 'Administrator',
      permissions: [{ resource: PermissionResource.STUDENTS, type: PermissionType.READ }],
    };

    it('should successfully add an admin', async () => {
      schoolRepository.findById.mockResolvedValue(mockSchool as any);
      staffValidator.validateStaffData.mockReturnValue(undefined);
      staffValidator.validateEmailUniqueInSchool.mockResolvedValue(undefined);
      staffValidator.validatePhoneUniqueInSchool.mockResolvedValue(undefined);
      idGenerator.generateAdminId.mockResolvedValue('AD-123');
      idGenerator.generatePublicId.mockResolvedValue('AG-TEST-ABC123');
      (prisma.$transaction as jest.Mock).mockImplementation(async (callback: (tx: any) => Promise<any>) => {
        const mockTx = TestUtils.createMockPrismaService();
        (mockTx.user.findUnique as jest.Mock).mockResolvedValue(null);
        (mockTx.user.create as jest.Mock).mockResolvedValue({ id: 'user-1' });
        (mockTx.schoolAdmin.create as jest.Mock).mockResolvedValue({
          id: 'admin-1',
          publicId: 'AG-TEST-ABC123',
          school: { id: 'school-1', name: 'Test School' },
          user: { id: 'user-1' },
        } as any);
        return callback(mockTx as any);
      });
      staffMapper.toAdminDto.mockReturnValue({ id: 'admin-1', ...mockAdminData } as any);
      const mockUser = { id: 'user-1', currentProfileId: 'admin-1' } as any;
      (prisma.schoolAdmin.findFirst as jest.Mock).mockResolvedValue({ id: 'admin-1', role: 'school_owner' } as any);

      const result = await service.addAdmin('school-1', mockAdminData, mockUser);

      expect(schoolRepository.findById).toHaveBeenCalledWith('school-1');
      expect(staffValidator.validateStaffData).toHaveBeenCalledWith(mockAdminData);
      expect(result).toBeDefined();
    });

    it('should throw BadRequestException if school not found', async () => {
      schoolRepository.findById.mockResolvedValue(null);

      const mockUser = { id: 'user-1' } as any;
      await expect(service.addAdmin('invalid-school', mockAdminData, mockUser)).rejects.toThrow(
        BadRequestException
      );
    });

    it('should throw ConflictException if email already exists', async () => {
      schoolRepository.findById.mockResolvedValue(mockSchool as any);
      staffValidator.validateEmailUniqueInSchool.mockRejectedValue(
        new ConflictException('Email already exists')
      );

      const mockUser = { id: 'user-1' } as any;
      await expect(service.addAdmin('school-1', mockAdminData, mockUser)).rejects.toThrow(ConflictException);
    });

    // Least privilege. Omitting access used to mean view access on every screen
    // in the school, so a new bursar could read grades on their first login.
    it('refuses a create that states no access at all', async () => {
      schoolRepository.findById.mockResolvedValue(mockSchool as any);
      staffValidator.validateStaffData.mockReturnValue(undefined);
      staffValidator.validateEmailUniqueInSchool.mockResolvedValue(undefined);
      staffValidator.validatePhoneUniqueInSchool.mockResolvedValue(undefined);

      const { permissions, ...withoutAccess } = mockAdminData;
      void permissions;

      await expect(
        service.addAdmin('school-1', withoutAccess as never, { id: 'user-1' } as never),
      ).rejects.toThrow(BadRequestException);
    });

    it('accepts an explicit empty list as "no dashboard access"', async () => {
      schoolRepository.findById.mockResolvedValue(mockSchool as any);
      staffValidator.validateStaffData.mockReturnValue(undefined);
      staffValidator.validateEmailUniqueInSchool.mockResolvedValue(undefined);
      staffValidator.validatePhoneUniqueInSchool.mockResolvedValue(undefined);
      idGenerator.generateAdminId.mockResolvedValue('AD-124');
      idGenerator.generatePublicId.mockResolvedValue('AG-TEST-EMPTY');
      (prisma.$transaction as jest.Mock).mockImplementation(async (callback: (tx: any) => Promise<any>) => {
        const mockTx = TestUtils.createMockPrismaService();
        (mockTx.user.findUnique as jest.Mock).mockResolvedValue(null);
        (mockTx.user.create as jest.Mock).mockResolvedValue({ id: 'user-2' });
        (mockTx.schoolAdmin.create as jest.Mock).mockResolvedValue({
          id: 'admin-2',
          school: mockSchool,
          user: { id: 'user-2' },
        } as any);
        return callback(mockTx as any);
      });
      staffMapper.toAdminDto.mockReturnValue({ id: 'admin-2' } as any);
      (prisma.schoolAdmin.findFirst as jest.Mock).mockResolvedValue({
        id: 'admin-1',
        role: 'school_owner',
        accessTier: 'PRINCIPAL',
      } as any);

      await expect(
        service.addAdmin(
          'school-1',
          { ...mockAdminData, permissions: [] } as never,
          { id: 'user-1', currentProfileId: 'admin-1' } as never,
        ),
      ).resolves.toBeDefined();
    });

    // The hole this whole change closes: the title box was a back door to the
    // guard bypass, because authority was inferred from what was typed.
    it('does not grant principal authority just because the title says Principal', async () => {
      schoolRepository.findById.mockResolvedValue(mockSchool as any);
      staffValidator.validateStaffData.mockReturnValue(undefined);
      staffValidator.validateEmailUniqueInSchool.mockResolvedValue(undefined);
      staffValidator.validatePhoneUniqueInSchool.mockResolvedValue(undefined);
      idGenerator.generatePrincipalId.mockResolvedValue('PR-1');
      idGenerator.generateAdminId.mockResolvedValue('AD-125');
      idGenerator.generatePublicId.mockResolvedValue('AG-TEST-TITLE');

      let created: { accessTier?: string } | undefined;
      (prisma.$transaction as jest.Mock).mockImplementation(async (callback: (tx: any) => Promise<any>) => {
        const mockTx = TestUtils.createMockPrismaService();
        (mockTx.user.findUnique as jest.Mock).mockResolvedValue(null);
        (mockTx.user.create as jest.Mock).mockResolvedValue({ id: 'user-3' });
        (mockTx.schoolAdmin.create as jest.Mock).mockImplementation(async (args: any) => {
          created = args.data;
          return { id: 'admin-3', school: mockSchool, user: { id: 'user-3' } };
        });
        return callback(mockTx as any);
      });
      staffMapper.toAdminDto.mockReturnValue({ id: 'admin-3' } as any);
      (prisma.schoolAdmin.findFirst as jest.Mock).mockResolvedValue({
        id: 'admin-1',
        role: 'school_owner',
        accessTier: 'PRINCIPAL',
      } as any);

      await service.addAdmin(
        'school-1',
        { ...mockAdminData, role: 'Principal' } as never,
        { id: 'user-1', currentProfileId: 'admin-1' } as never,
      );

      expect(created?.accessTier).toBe('STAFF');
    });
  });

  describe('updateAdmin', () => {
    const mockSchool = { id: 'school-1' };
    const mockAdmin = {
      id: 'admin-1',
      schoolId: 'school-1',
      role: 'Administrator',
    };

    it('should successfully update an admin', async () => {
      schoolRepository.findById.mockResolvedValue(mockSchool as any);
      staffRepository.findAdminById.mockResolvedValue(mockAdmin as any);
      staffRepository.updateAdmin.mockResolvedValue({
        ...mockAdmin,
        firstName: 'Updated',
      } as any);
      staffMapper.toAdminDto.mockReturnValue({ id: 'admin-1', firstName: 'Updated' } as any);

      const mockUser = { id: 'user-1' } as any;
      (prisma.schoolAdmin.findFirst as jest.Mock).mockResolvedValue({ id: 'admin-1', role: 'school_owner' } as any);

      const result = await service.updateAdmin('school-1', 'admin-1', {
        firstName: 'Updated',
      }, mockUser);

      expect(result).toBeDefined();
      expect(staffRepository.updateAdmin).toHaveBeenCalled();
    });

    it('should throw BadRequestException if admin not found', async () => {
      schoolRepository.findById.mockResolvedValue(mockSchool as any);
      staffRepository.findAdminById.mockResolvedValue(null);

      const mockUser = { id: 'user-1' } as any;
      await expect(
        service.updateAdmin('school-1', 'invalid-admin', { firstName: 'Updated' }, mockUser)
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('deleteAdmin', () => {
    const mockSchool = { id: 'school-1', isActive: true };
    const mockAdmin = {
      id: 'admin-1',
      schoolId: 'school-1',
      role: 'Administrator',
    };

    it('should successfully delete an admin', async () => {
      schoolRepository.findById.mockResolvedValue(mockSchool as any);
      staffRepository.findAdminById.mockResolvedValue(mockAdmin as any);
      staffRepository.deleteAdmin.mockResolvedValue(mockAdmin as any);

      const mockUser = { id: 'user-1' } as any;
      (prisma.schoolAdmin.findFirst as jest.Mock).mockResolvedValue({ id: 'admin-req', role: 'school_owner' } as any);

      await service.deleteAdmin('school-1', 'admin-1', mockUser);

      expect(staffRepository.deleteAdmin).toHaveBeenCalledWith('admin-1');
    });

    it('should throw BadRequestException if admin is principal and active', async () => {
      const principalAdmin = {
        ...mockAdmin,
        role: 'Principal',
        accessTier: 'PRINCIPAL',
        user: { accountStatus: 'ACTIVE' },
      };
      schoolRepository.findById.mockResolvedValue(mockSchool as any);
      staffRepository.findAdminById.mockResolvedValue(principalAdmin as any);
      staffRepository.findAdminsBySchool.mockResolvedValue([principalAdmin] as any);
      (prisma.schoolAdmin.findFirst as jest.Mock).mockResolvedValue(principalAdmin as any);

      const mockUser = { id: 'user-1' } as any;
      await expect(service.deleteAdmin('school-1', 'admin-1', mockUser)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('changeAccessTier', () => {
    const mockSchool = { id: 'school-1', name: 'Test School' };
    const owner = { id: 'admin-owner', role: 'school_owner', accessTier: 'PRINCIPAL' };

    const arrange = (target: Record<string, unknown>) => {
      schoolRepository.findById.mockResolvedValue(mockSchool as any);
      (prisma.schoolAdmin.findFirst as jest.Mock)
        .mockResolvedValueOnce(owner as any) // requesting admin
        .mockResolvedValueOnce(target as any); // target admin
    };

    // The silent-lockout bug. A principal holds no permission rows, so dropping
    // the tier without naming replacement access leaves an empty dashboard.
    it('refuses a demotion that names no replacement access', async () => {
      arrange({ id: 'admin-1', role: 'Vice Principal', accessTier: 'PRINCIPAL' });

      await expect(
        service.changeAccessTier(
          'school-1',
          'admin-1',
          { accessTier: 'STAFF' } as never,
          { id: 'user-1', role: 'SCHOOL_ADMIN' } as never,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('applies the tier and the replacement set together', async () => {
      arrange({ id: 'admin-1', role: 'Vice Principal', accessTier: 'PRINCIPAL' });
      const tx = {
        schoolAdmin: { update: jest.fn() },
        staffPermission: { deleteMany: jest.fn(), createMany: jest.fn() },
      };
      (prisma.$transaction as jest.Mock).mockImplementation(async (cb: (t: unknown) => unknown) =>
        cb(tx),
      );

      await service.changeAccessTier(
        'school-1',
        'admin-1',
        { accessTier: 'STAFF', roleTemplateId: 'tpl-bursar' } as never,
        { id: 'user-1', role: 'SCHOOL_ADMIN' } as never,
      );

      expect(roleTemplates.permissionIdsForTemplate).toHaveBeenCalledWith(
        'school-1',
        'tpl-bursar',
      );
      // Both halves land in one transaction, so there is no window in which the
      // admin has lost the bypass but not yet gained the replacement rows.
      expect(tx.schoolAdmin.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ accessTier: 'STAFF', roleTemplateId: 'tpl-bursar' }),
        }),
      );
      expect(tx.staffPermission.deleteMany).toHaveBeenCalledWith({
        where: { adminId: 'admin-1' },
      });
      expect(tx.staffPermission.createMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: [{ adminId: 'admin-1', permissionId: 'perm-1' }] }),
      );
    });

    it('refuses to move the school owner off principal-level access', async () => {
      arrange({ id: 'admin-owner-2', role: 'school_owner', accessTier: 'PRINCIPAL' });

      await expect(
        service.changeAccessTier(
          'school-1',
          'admin-owner-2',
          { accessTier: 'STAFF', roleTemplateId: 'tpl-bursar' } as never,
          { id: 'user-1', role: 'SCHOOL_ADMIN' } as never,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses to change your own tier', async () => {
      schoolRepository.findById.mockResolvedValue(mockSchool as any);
      (prisma.schoolAdmin.findFirst as jest.Mock)
        .mockResolvedValueOnce(owner as any)
        .mockResolvedValueOnce(owner as any);

      await expect(
        service.changeAccessTier(
          'school-1',
          owner.id,
          { accessTier: 'STAFF', roleTemplateId: 'tpl-bursar' } as never,
          { id: 'user-1', role: 'SCHOOL_ADMIN' } as never,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses a no-op', async () => {
      arrange({ id: 'admin-1', role: 'Bursar', accessTier: 'STAFF' });

      await expect(
        service.changeAccessTier(
          'school-1',
          'admin-1',
          { accessTier: 'STAFF', roleTemplateId: 'tpl-bursar' } as never,
          { id: 'user-1', role: 'SCHOOL_ADMIN' } as never,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('gates both directions through the owner-only validator', async () => {
      arrange({ id: 'admin-1', role: 'Bursar', accessTier: 'STAFF' });

      await service.changeAccessTier(
        'school-1',
        'admin-1',
        { accessTier: 'PRINCIPAL' } as never,
        { id: 'user-1', role: 'SCHOOL_ADMIN' } as never,
      );

      expect(staffValidator.assertCanGrantPrincipalTier).toHaveBeenCalled();
    });
  });
});
