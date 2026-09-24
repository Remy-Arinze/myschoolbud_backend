import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { StudentsService } from './students.service';
import { PrismaService } from '../database/prisma.service';
import { TimetableService } from '../timetable/timetable.service';
import { GradesService } from '../grades/grades.service';
import { EventService } from '../events/event.service';
import { CloudinaryService } from '../storage/cloudinary/cloudinary.service';
import { ExamTimetableService } from '../exam-timetable/exam-timetable.service';
import { LiveStatusService } from '../live-status/live-status.service';
import { NotificationService } from '../notification/notification.service';
import { SchoolSettingsService } from '../school-settings/school-settings.service';
import { TestUtils } from '../common/test/test-utils';
import { UserWithContext } from '../auth/types/user-with-context.type';

describe('StudentsService', () => {
  let service: StudentsService;
  let prisma: jest.Mocked<PrismaService>;
  let timetableService: jest.Mocked<TimetableService>;
  let gradesService: jest.Mocked<GradesService>;
  let eventService: jest.Mocked<EventService>;
  let cloudinaryService: jest.Mocked<CloudinaryService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StudentsService,
        {
          provide: PrismaService,
          useValue: TestUtils.createMockPrismaService(),
        },
        {
          provide: TimetableService,
          useValue: {
            getTimetableForClass: jest.fn(),
          },
        },
        {
          provide: GradesService,
          useValue: {
            getGradesForStudent: jest.fn(),
          },
        },
        {
          provide: EventService,
          useValue: {
            getEventsForSchool: jest.fn(),
          },
        },
        {
          provide: CloudinaryService,
          useValue: TestUtils.createMockCloudinaryService(),
        },
        {
          provide: ExamTimetableService,
          useValue: {},
        },
        {
          provide: LiveStatusService,
          useValue: {
            getCurrentActivities: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: NotificationService,
          useValue: {},
        },
        {
          provide: SchoolSettingsService,
          useValue: {
            getRuntimePolicies: jest.fn().mockResolvedValue({}),
            getAdmissionPolicy: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<StudentsService>(StudentsService);
    prisma = module.get(PrismaService);
    timetableService = module.get(TimetableService);
    gradesService = module.get(GradesService);
    eventService = module.get(EventService);
    cloudinaryService = module.get(CloudinaryService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('findAll', () => {
    const mockTenantId = 'school-1';
    const mockPagination = { page: 1, limit: 20 };

    it('should return paginated students', async () => {
      const mockStudents = [
        {
          id: 'student-1',
          uid: 'STU-001',
          firstName: 'John',
          lastName: 'Doe',
          middleName: null,
          dateOfBirth: new Date('2010-01-01'),
          profileLocked: false,
          profileImage: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          user: null,
          enrollments: [
            {
              id: 'enrollment-1',
              classLevel: 'Primary 1',
              academicYear: '2024/2025',
              enrollmentDate: new Date(),
              school: { id: mockTenantId, name: 'Test School' },
            },
          ],
        },
      ];

      (prisma.class.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.classArm.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.classLevel.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.student.findMany as jest.Mock).mockResolvedValue(mockStudents as any);
      (prisma.student.count as jest.Mock).mockImplementation(
        (args?: { where?: { user?: { accountStatus?: string } } }) => {
          const status = args?.where?.user?.accountStatus;
          if (status === 'ACTIVE') return Promise.resolve(4);
          if (status === 'SHADOW') return Promise.resolve(2);
          if (status === 'SUSPENDED') return Promise.resolve(1);
          if (status === 'ARCHIVED') return Promise.resolve(0);
          return Promise.resolve(7);
        },
      );

      const result = await service.findAll(mockTenantId, mockPagination);

      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('total', 7);
      expect(result).toHaveProperty('page', 1);
      expect(result).toHaveProperty('limit', 20);
      expect(result.statusCounts).toEqual({
        active: 4,
        pending: 2,
        suspended: 1,
        archived: 0,
      });
    });

    it('should return empty result when no classes found for school type', async () => {
      (prisma.class.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.classArm.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.classLevel.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.findAll(mockTenantId, mockPagination, 'PRIMARY');

      expect(result.data).toHaveLength(0);
      expect(result.total).toBe(0);
      expect(result.statusCounts).toEqual({
        active: 0,
        pending: 0,
        suspended: 0,
        archived: 0,
      });
    });
  });

  describe('findOne', () => {
    const mockTenantId = 'school-1';
    const mockStudentId = 'student-1';

    it('should return student by ID', async () => {
      const mockStudent = {
        id: mockStudentId,
        uid: 'STU-001',
        firstName: 'John',
        lastName: 'Doe',
        middleName: null,
        dateOfBirth: new Date('2010-01-01'),
        profileLocked: false,
        profileImage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        user: { id: 'user-1', email: 'john@example.com', phone: null, accountStatus: 'ACTIVE' },
        enrollments: [
          {
            id: 'enrollment-1',
            classLevel: 'Primary 1',
            academicYear: '2024/2025',
            enrollmentDate: new Date(),
            school: { id: mockTenantId, name: 'Test School' },
          },
        ],
      };

      (prisma.student.findFirst as jest.Mock).mockResolvedValue(mockStudent as any);

      const result = await service.findOne(mockTenantId, mockStudentId);

      expect(prisma.student.findFirst).toHaveBeenCalled();
      expect(result).toHaveProperty('id', mockStudentId);
    });

    it('should throw NotFoundException if student not found', async () => {
      (prisma.student.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(service.findOne(mockTenantId, mockStudentId)).rejects.toThrow(
        NotFoundException
      );
    });
  });

  describe('findByUid', () => {
    const mockTenantId = 'school-1';
    const mockUid = 'STU-001';

    it('should return student by UID', async () => {
      const mockStudent = {
        id: 'student-1',
        uid: mockUid,
        firstName: 'John',
        lastName: 'Doe',
        middleName: null,
        dateOfBirth: new Date('2010-01-01'),
        profileLocked: false,
        profileImage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        user: { id: 'user-1', email: 'john@example.com', phone: null, accountStatus: 'ACTIVE' },
        enrollments: [
          {
            id: 'enrollment-1',
            classLevel: 'Primary 1',
            academicYear: '2024/2025',
            enrollmentDate: new Date(),
            school: { id: mockTenantId, name: 'Test School' },
          },
        ],
      };

      (prisma.student.findUnique as jest.Mock).mockResolvedValue(mockStudent as any);

      const result = await service.findByUid(mockTenantId, mockUid);

      expect(prisma.student.findUnique).toHaveBeenCalled();
      expect(result).toHaveProperty('uid', mockUid);
    });

    it('should throw NotFoundException if student not found', async () => {
      (prisma.student.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.findByUid(mockTenantId, mockUid)).rejects.toThrow(NotFoundException);
    });
  });

  describe('getMyProfile', () => {
    const mockUser: UserWithContext = {
      id: 'user-1',
      email: 'student@example.com',
      role: 'STUDENT',
      currentSchoolId: 'school-1',
    } as UserWithContext;

    it('should return student profile', async () => {
      const mockStudent = {
        id: 'student-1',
        uid: 'STU-001',
        firstName: 'John',
        lastName: 'Doe',
        middleName: null,
        dateOfBirth: new Date('2010-01-01'),
        profileLocked: false,
        profileImage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        user: {
          id: mockUser.id,
          email: mockUser.email,
          phone: null,
          accountStatus: 'ACTIVE',
        },
        enrollments: [
          {
            id: 'enrollment-1',
            classLevel: 'Primary 1',
            academicYear: '2024/2025',
            enrollmentDate: new Date(),
            isActive: true,
            school: { id: 'school-1', name: 'Test School' },
          },
        ],
      };

      (prisma.student.findFirst as jest.Mock).mockResolvedValue(mockStudent as any);

      const result = await service.getMyProfile(mockUser);

      expect(prisma.student.findFirst).toHaveBeenCalled();
      expect(result).toHaveProperty('uid', 'STU-001');
    });
  });
});
