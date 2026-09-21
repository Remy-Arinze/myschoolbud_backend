import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { SuperAdminSchoolsService } from './super-admin-schools.service';
import { SchoolRepository } from '../domain/repositories/school.repository';
import { StaffRepository } from '../domain/repositories/staff.repository';
import { SchoolMapper } from '../domain/mappers/school.mapper';
import { IdGeneratorService } from '../shared/id-generator.service';
import { SchoolValidatorService } from '../shared/school-validator.service';
import { StaffValidatorService } from '../shared/staff-validator.service';
import { PrismaService } from '../../database/prisma.service';
import { AuthService } from '../../auth/auth.service';
import { EmailService } from '../../email/email.service';
import { TestUtils } from '../../common/test/test-utils';
import { PortalsService } from '../../portals/portals.service';
import { SchoolLifecycleService } from '../lifecycle/school-lifecycle.service';

describe('SuperAdminSchoolsService', () => {
  let service: SuperAdminSchoolsService;
  let schoolRepository: jest.Mocked<SchoolRepository>;
  let schoolMapper: jest.Mocked<SchoolMapper>;
  let idGenerator: jest.Mocked<IdGeneratorService>;
  let schoolValidator: jest.Mocked<SchoolValidatorService>;
  let prisma: jest.Mocked<PrismaService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SuperAdminSchoolsService,
        {
          provide: SchoolRepository,
          useValue: {
            findById: jest.fn(),
            findById: jest.fn(),
            findAll: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            delete: jest.fn(),
          },
        },
        {
          provide: StaffRepository,
          useValue: {
            createAdmin: jest.fn(),
          },
        },
        {
          provide: SchoolMapper,
          useValue: {
            toDto: jest.fn(),
            toDtoArray: jest.fn(),
          },
        },
        {
          provide: IdGeneratorService,
          useValue: {
            generateSchoolId: jest.fn(),
            generatePrincipalId: jest.fn(),
            generateAdminId: jest.fn(),
            generatePublicId: jest.fn(),
          },
        },
        {
          provide: SchoolValidatorService,
          useValue: {
            validateSchoolData: jest.fn(),
            validateSubdomainUnique: jest.fn(),
            validateSchoolExists: jest.fn(),
          },
        },
        {
          provide: StaffValidatorService,
          useValue: {
            validatePrincipalRole: jest.fn(),
            validateUniqueCanonicalTitle: jest.fn(),
            assertCanAssignPrincipalTitle: jest.fn(),
            validateStaffData: jest.fn(),
          },
        },
        {
          provide: PrismaService,
          useValue: {
            ...TestUtils.createMockPrismaService(),
            $transaction: jest.fn((callback) => callback(prisma)),
          },
        },
        {
          provide: AuthService,
          useValue: {
            sendPasswordResetForNewUser: jest.fn(),
          },
        },
        {
          provide: EmailService,
          useValue: TestUtils.createMockEmailService(),
        },
        {
          provide: PortalsService,
          useValue: {
            ensureSlug: jest.fn().mockResolvedValue('test-school'),
            lockSlug: jest.fn().mockResolvedValue(undefined),
            holdSlugOnReject: jest.fn().mockResolvedValue(undefined),
            renameSlug: jest.fn().mockResolvedValue('test-school'),
            reserveSlug: jest.fn().mockResolvedValue('test-school'),
            assignSlugFromName: jest.fn().mockResolvedValue('test-school'),
            getSchoolFrontendUrl: jest.fn().mockResolvedValue('http://test-school.localhost:3000'),
            buildPortalUrl: jest.fn().mockReturnValue('http://test-school.localhost:3000'),
          },
        },
        {
          provide: SchoolLifecycleService,
          useValue: {
            scheduleClose: jest.fn(),
            cancelClose: jest.fn(),
            reactivate: jest.fn(),
            assertOwnerOrPrincipal: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<SuperAdminSchoolsService>(SuperAdminSchoolsService);
    schoolRepository = module.get(SchoolRepository);
    schoolMapper = module.get(SchoolMapper);
    idGenerator = module.get(IdGeneratorService);
    schoolValidator = module.get(SchoolValidatorService);
    prisma = module.get(PrismaService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createSchool', () => {
    const mockCreateSchoolDto = {
      name: 'Test School',
      subdomain: 'test-school',
      country: 'Nigeria',
      owner: {
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'owner@example.com',
        phone: '+2348000000000',
      },
    };

    it('should successfully create a school', async () => {
      schoolValidator.validateSchoolData.mockReturnValue(undefined);
      schoolValidator.validateSubdomainUnique.mockResolvedValue(undefined);
      idGenerator.generateSchoolId.mockResolvedValue('SCH-123');
      (prisma.$transaction as jest.Mock).mockImplementation(async (callback: (tx: any) => Promise<any>) => {
        const mockTx = TestUtils.createMockPrismaService();
        (mockTx.school.create as jest.Mock).mockResolvedValue({ id: 'school-1', ...mockCreateSchoolDto });
        (mockTx.user.findUnique as jest.Mock).mockResolvedValue(null);
        (mockTx.user.create as jest.Mock).mockResolvedValue({ id: 'user-1' });
        return callback(mockTx as any);
      });
      (prisma.school.findUnique as jest.Mock).mockResolvedValue({
        id: 'school-1',
        admins: [],
        teachers: [],
        enrollments: [],
      } as any);
      schoolMapper.toDto.mockReturnValue({ id: 'school-1' } as any);

      const result = await service.createSchool(mockCreateSchoolDto);

      expect(result).toBeDefined();
    });
  });

  describe('findAll', () => {
    it('should return paginated schools', async () => {
      const mockSchools = [{ id: 'school-1' }, { id: 'school-2' }];
      (prisma.school.findMany as jest.Mock).mockResolvedValue(mockSchools as any);
      (prisma.school.count as jest.Mock).mockResolvedValue(2);
      (prisma.enrollment.groupBy as jest.Mock).mockResolvedValue([]);
      (prisma.teacher.groupBy as jest.Mock).mockResolvedValue([]);
      schoolMapper.toDtoArray.mockReturnValue(mockSchools as any);

      const result = await service.findAll();

      expect(result.data).toEqual(mockSchools);
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(10);
      expect(schoolMapper.toDtoArray).toHaveBeenCalled();
    });
  });

  describe('findOne', () => {
    it('should return a school by ID', async () => {
      const mockSchool = { id: 'school-1' };
      schoolRepository.findById.mockResolvedValue(mockSchool as any);
      (prisma.school.findUnique as jest.Mock).mockResolvedValue({
        ...mockSchool,
        admins: [],
        teachers: [],
        enrollments: [],
      } as any);
      schoolMapper.toDto.mockReturnValue(mockSchool as any);

      const result = await service.findOne('school-1');

      expect(result).toEqual(mockSchool);
    });

    it('should throw BadRequestException if school not found', async () => {
      schoolRepository.findById.mockResolvedValue(null);

      await expect(service.findOne('invalid-id')).rejects.toThrow(BadRequestException);
    });
  });
});
