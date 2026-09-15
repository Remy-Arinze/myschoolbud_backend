import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import {
  DEFAULT_STRUCTURE_CONFIG,
  DEFAULT_GRADING_POLICY,
  DEFAULT_ADMISSION_POLICY,
  DEFAULT_TIMETABLE_POLICY,
  DEFAULT_ATTENDANCE_POLICY,
  DEFAULT_NOTIFICATION_POLICY,
  DEFAULT_FINANCE_POLICY,
  DEFAULT_CURRICULUM_POLICY,
  DEFAULT_SECURITY_POLICY,
} from './school-settings.defaults';
import { UpdateStructureSettingsDto } from './dto/update-structure-settings.dto';
import { UpdateCalendarSettingsDto } from './dto/update-calendar-settings.dto';
import { UpdateGradingSettingsDto } from './dto/update-grading-settings.dto';
import { UpdatePermissionsSettingsDto } from './dto/update-permissions-settings.dto';
import { UpdateAdmissionsSettingsDto } from './dto/update-admissions-settings.dto';
import { UpdateTimetableSettingsDto } from './dto/update-timetable-settings.dto';
import { UpdateAttendanceSettingsDto } from './dto/update-attendance-settings.dto';
import { UpdateCommunicationsSettingsDto } from './dto/update-communications-settings.dto';
import { UpdateFinanceSettingsDto } from './dto/update-finance-settings.dto';
import { UpdateCurriculumSettingsDto } from './dto/update-curriculum-settings.dto';
import { UpdateSecuritySettingsDto } from './dto/update-security-settings.dto';
import { CreateHolidayPresetDto, UpdateHolidayPresetDto } from './dto/holiday-preset.dto';
import { CreateRoleTemplateDto, UpdateRoleTemplateDto } from './dto/role-template.dto';
import { CreateAssessmentTemplateDto, UpdateAssessmentTemplateDto } from './dto/assessment-template.dto';
import { CreateFeeCategoryDto, UpdateFeeCategoryDto } from './dto/fee-category.dto';
import { CreateFeeScheduleDto, UpdateFeeScheduleDto } from './dto/fee-schedule.dto';
import { CreateKnowledgeDocumentDto } from './dto/knowledge-document.dto';
import { pickDefined } from './school-settings.utils';
import { EventType, Prisma } from '@prisma/client';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

const VECTOR_QUEUE_NAME = '{vector}';
const JOB_GENERATE_EMBEDDING = 'generate-embedding';

export type SettingsSection =
  | 'structure'
  | 'calendar'
  | 'grading'
  | 'permissions'
  | 'admissions'
  | 'timetable'
  | 'attendance'
  | 'communications'
  | 'finance'
  | 'curriculum'
  | 'security';

export interface RuntimePolicies {
  workingDays: string[];
  terminologyOverrides?: Record<string, string> | null;
  facultyStructureVisible: boolean;
  teacherScope: string;
  subjectRegistryMode: string;
  defaultClassArmNames: string[];
  classLevelNamingMode: string;
  attendanceStatusOptions: string[];
  grading: {
    gradeScaleType: string;
    passMark: number;
    defaultCaWeight: number;
    defaultExamWeight: number;
    templatesMode: string;
    defaultAllowLateSubmissionAfterDue: boolean;
    defaultAllowLateSubmissionAfterTimer: boolean;
    defaultLateDuePenalty: number;
    defaultLateTimerPenalty: number;
    defaultIntegrityEnabled: boolean;
    defaultViolationThreshold: number;
    defaultPointsPerViolation: number;
    templates?: Array<{
      id: string;
      name: string;
      gradeType: string;
      maxScore: number;
      weight?: number | null;
      sequence?: number | null;
    }>;
  };
  timetable: {
    defaultPeriodLengthMinutes: number;
    maxPeriodsPerTeacherPerDay: number;
    roomCapacityWarningEnabled: boolean;
    examBlackoutEnabled: boolean;
  };
  bellScheduleTemplates: Array<{ schoolType: string; periods: unknown; isDefault: boolean }>;
}

@Injectable()
export class SchoolSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(VECTOR_QUEUE_NAME) private readonly vectorQueue: Queue,
  ) {}

  async ensureDefaults(schoolId: string): Promise<void> {
    if (!schoolId) {
      throw new BadRequestException('School context is required to load settings.');
    }
    await Promise.all([
      this.prisma.schoolStructureConfig.upsert({
        where: { schoolId },
        create: { schoolId, ...DEFAULT_STRUCTURE_CONFIG },
        update: {},
      }),
      this.prisma.gradingPolicy.upsert({
        where: { schoolId },
        create: { schoolId, ...DEFAULT_GRADING_POLICY },
        update: {},
      }),
      this.prisma.admissionPolicy.upsert({
        where: { schoolId },
        create: { schoolId, ...DEFAULT_ADMISSION_POLICY },
        update: {},
      }),
      this.prisma.timetablePolicy.upsert({
        where: { schoolId },
        create: { schoolId, ...DEFAULT_TIMETABLE_POLICY },
        update: {},
      }),
      this.prisma.attendancePolicy.upsert({
        where: { schoolId },
        create: { schoolId, ...DEFAULT_ATTENDANCE_POLICY },
        update: {},
      }),
      this.prisma.notificationPolicy.upsert({
        where: { schoolId },
        create: { schoolId, ...DEFAULT_NOTIFICATION_POLICY },
        update: {},
      }),
      this.prisma.financePolicy.upsert({
        where: { schoolId },
        create: { schoolId, ...DEFAULT_FINANCE_POLICY },
        update: {},
      }),
      this.prisma.curriculumPolicy.upsert({
        where: { schoolId },
        create: { schoolId, ...DEFAULT_CURRICULUM_POLICY },
        update: {},
      }),
      this.prisma.securityPolicy.upsert({
        where: { schoolId },
        create: { schoolId, ...DEFAULT_SECURITY_POLICY },
        update: {},
      }),
    ]);
  }

  async getAllSettings(schoolId: string) {
    await this.ensureDefaults(schoolId);
    const school = await this.prisma.school.findUniqueOrThrow({
      where: { id: schoolId },
      select: {
        id: true,
        name: true,
        workingDays: true,
        structureConfig: true,
        holidayPresets: { orderBy: { startDate: 'asc' } },
        gradingPolicy: true,
        roleTemplates: { orderBy: { name: 'asc' } },
        admissionPolicy: true,
        bellScheduleTemplates: true,
        timetablePolicy: true,
        attendancePolicy: true,
        notificationPolicy: true,
        feeCategories: { include: { schedules: true }, orderBy: { name: 'asc' } },
        financePolicy: true,
        curriculumPolicy: true,
        loisConfig: true,
        securityPolicy: true,
        assessmentTemplates: { where: { isActive: true }, orderBy: { sequence: 'asc' } },
        knowledgeChunks: { orderBy: { createdAt: 'desc' }, take: 50 },
      },
    });
    return school;
  }

  async getSection(schoolId: string, section: SettingsSection) {
    await this.ensureDefaults(schoolId);
    switch (section) {
      case 'structure':
        return this.prisma.schoolStructureConfig.findUniqueOrThrow({ where: { schoolId } });
      case 'calendar': {
        const school = await this.prisma.school.findUniqueOrThrow({
          where: { id: schoolId },
          select: { workingDays: true, holidayPresets: { orderBy: { startDate: 'asc' } } },
        });
        return school;
      }
      case 'grading':
        return {
          policy: await this.prisma.gradingPolicy.findUniqueOrThrow({ where: { schoolId } }),
          templates: await this.prisma.assessmentTemplate.findMany({
            where: { schoolId },
            orderBy: [{ sequence: 'asc' }, { name: 'asc' }],
          }),
        };
      case 'permissions':
        return {
          structure: await this.prisma.schoolStructureConfig.findUniqueOrThrow({ where: { schoolId } }),
          roleTemplates: await this.prisma.roleTemplate.findMany({
            where: { schoolId },
            orderBy: { name: 'asc' },
          }),
        };
      case 'admissions':
        return this.prisma.admissionPolicy.findUniqueOrThrow({ where: { schoolId } });
      case 'timetable':
        return {
          policy: await this.prisma.timetablePolicy.findUniqueOrThrow({ where: { schoolId } }),
          bellScheduleTemplates: await this.prisma.bellScheduleTemplate.findMany({ where: { schoolId } }),
        };
      case 'attendance':
        return this.prisma.attendancePolicy.findUniqueOrThrow({ where: { schoolId } });
      case 'communications':
        return this.prisma.notificationPolicy.findUniqueOrThrow({ where: { schoolId } });
      case 'finance':
        return {
          policy: await this.prisma.financePolicy.findUniqueOrThrow({ where: { schoolId } }),
          categories: await this.prisma.feeCategory.findMany({
            where: { schoolId },
            include: { schedules: true },
            orderBy: { name: 'asc' },
          }),
        };
      case 'curriculum':
        return {
          policy: await this.prisma.curriculumPolicy.findUniqueOrThrow({ where: { schoolId } }),
          loisConfig: await this.prisma.loisConfig.findUnique({ where: { schoolId } }),
          knowledgeChunks: await this.prisma.knowledgeChunk.findMany({
            where: { schoolId },
            orderBy: { createdAt: 'desc' },
            take: 50,
          }),
        };
      case 'security':
        return this.prisma.securityPolicy.findUniqueOrThrow({ where: { schoolId } });
      default:
        throw new BadRequestException(`Unknown settings section: ${section}`);
    }
  }

  async updateSection(schoolId: string, section: SettingsSection, dto: Record<string, unknown>) {
    await this.ensureDefaults(schoolId);
    switch (section) {
      case 'structure':
        return this.updateStructure(schoolId, dto as UpdateStructureSettingsDto);
      case 'calendar':
        return this.updateCalendar(schoolId, dto as UpdateCalendarSettingsDto);
      case 'grading':
        return this.updateGrading(schoolId, dto as UpdateGradingSettingsDto);
      case 'permissions':
        return this.updatePermissions(schoolId, dto as UpdatePermissionsSettingsDto);
      case 'admissions':
        return this.updateAdmissions(schoolId, dto as UpdateAdmissionsSettingsDto);
      case 'timetable':
        return this.updateTimetable(schoolId, dto as UpdateTimetableSettingsDto);
      case 'attendance':
        return this.updateAttendance(schoolId, dto as UpdateAttendanceSettingsDto);
      case 'communications':
        return this.updateCommunications(schoolId, dto as UpdateCommunicationsSettingsDto);
      case 'finance':
        return this.updateFinance(schoolId, dto as UpdateFinanceSettingsDto);
      case 'curriculum':
        return this.updateCurriculum(schoolId, dto as UpdateCurriculumSettingsDto);
      case 'security':
        return this.updateSecurity(schoolId, dto as UpdateSecuritySettingsDto);
      default:
        throw new BadRequestException(`Unknown settings section: ${section}`);
    }
  }

  private async updateStructure(schoolId: string, dto: UpdateStructureSettingsDto) {
    return this.prisma.schoolStructureConfig.update({
      where: { schoolId },
      data: pickDefined({
        terminologyOverrides: dto.terminologyOverrides,
        defaultClassArmNames: dto.defaultClassArmNames,
        classLevelNamingMode: dto.classLevelNamingMode,
        subjectRegistryMode: dto.subjectRegistryMode,
        defaultAgoraSubjectIds: dto.defaultAgoraSubjectIds,
        facultyStructureVisible: dto.facultyStructureVisible,
        teacherScope: dto.teacherScope,
        customRoles: dto.customRoles,
        admissionApproverRoles: dto.admissionApproverRoles,
        transferApproverRoles: dto.transferApproverRoles,
      }),
    });
  }

  private async updateCalendar(schoolId: string, dto: UpdateCalendarSettingsDto) {
    if (dto.workingDays?.length) {
      await this.prisma.school.update({
        where: { id: schoolId },
        data: { workingDays: dto.workingDays },
      });
    }
    return this.getSection(schoolId, 'calendar');
  }

  private async updateGrading(schoolId: string, dto: UpdateGradingSettingsDto) {
    const { templates: _templates, ...policyFields } = dto;
    const updated = await this.prisma.gradingPolicy.update({
      where: { schoolId },
      data: pickDefined(policyFields as Record<string, unknown>),
    });
    return { policy: updated };
  }

  private async updatePermissions(schoolId: string, dto: UpdatePermissionsSettingsDto) {
    await this.prisma.schoolStructureConfig.update({
      where: { schoolId },
      data: {
        customRoles: dto.customRoles,
        teacherScope: dto.teacherScope,
        admissionApproverRoles: dto.admissionApproverRoles,
        transferApproverRoles: dto.transferApproverRoles,
      },
    });
    return this.getSection(schoolId, 'permissions');
  }

  private async updateAdmissions(schoolId: string, dto: UpdateAdmissionsSettingsDto) {
    return this.prisma.admissionPolicy.update({
      where: { schoolId },
      data: pickDefined({
        applicationsOpen: dto.applicationsOpen,
        tacExpiryDays: dto.tacExpiryDays,
        transferPolicy: dto.transferPolicy,
        formFields: dto.formFields as Prisma.InputJsonValue | undefined,
        documentRequirements: dto.documentRequirements as Prisma.InputJsonValue | undefined,
        applicationDeadline: dto.applicationDeadline
          ? new Date(dto.applicationDeadline)
          : dto.applicationDeadline === null
            ? null
            : undefined,
      }),
    });
  }

  private async updateTimetable(schoolId: string, dto: UpdateTimetableSettingsDto) {
    const { bellScheduleTemplates, ...policy } = dto;
    await this.prisma.timetablePolicy.update({ where: { schoolId }, data: policy });
    if (bellScheduleTemplates?.length) {
      for (const tpl of bellScheduleTemplates) {
        if (tpl.id) {
          await this.prisma.bellScheduleTemplate.update({
            where: { id: tpl.id },
            data: { periods: tpl.periods as Prisma.InputJsonValue, isDefault: tpl.isDefault ?? true },
          });
        } else {
          await this.prisma.bellScheduleTemplate.create({
            data: {
              schoolId,
              schoolType: tpl.schoolType,
              periods: tpl.periods as Prisma.InputJsonValue,
              isDefault: tpl.isDefault ?? true,
            },
          });
        }
      }
    }
    return this.getSection(schoolId, 'timetable');
  }

  private async updateAttendance(schoolId: string, dto: UpdateAttendanceSettingsDto) {
    return this.prisma.attendancePolicy.update({ where: { schoolId }, data: dto });
  }

  private async updateCommunications(schoolId: string, dto: UpdateCommunicationsSettingsDto) {
    return this.prisma.notificationPolicy.update({ where: { schoolId }, data: dto });
  }

  private async updateFinance(schoolId: string, dto: UpdateFinanceSettingsDto) {
    return this.prisma.financePolicy.update({ where: { schoolId }, data: dto });
  }

  private async updateCurriculum(schoolId: string, dto: UpdateCurriculumSettingsDto) {
    return this.prisma.curriculumPolicy.update({ where: { schoolId }, data: dto });
  }

  private async updateSecurity(schoolId: string, dto: UpdateSecuritySettingsDto) {
    return this.prisma.securityPolicy.update({ where: { schoolId }, data: dto });
  }

  // --- Holiday presets ---
  async createHolidayPreset(schoolId: string, dto: CreateHolidayPresetDto) {
    return this.prisma.schoolHolidayPreset.create({
      data: {
        schoolId,
        name: dto.name,
        startDate: new Date(dto.startDate),
        endDate: new Date(dto.endDate),
        recurringRule: dto.recurringRule,
        schoolType: dto.schoolType,
      },
    });
  }

  async updateHolidayPreset(schoolId: string, id: string, dto: UpdateHolidayPresetDto) {
    const preset = await this.prisma.schoolHolidayPreset.findFirst({ where: { id, schoolId } });
    if (!preset) throw new NotFoundException('Holiday preset not found');
    return this.prisma.schoolHolidayPreset.update({
      where: { id },
      data: {
        name: dto.name,
        startDate: dto.startDate ? new Date(dto.startDate) : undefined,
        endDate: dto.endDate ? new Date(dto.endDate) : undefined,
        recurringRule: dto.recurringRule,
        schoolType: dto.schoolType,
      },
    });
  }

  async deleteHolidayPreset(schoolId: string, id: string) {
    const preset = await this.prisma.schoolHolidayPreset.findFirst({ where: { id, schoolId } });
    if (!preset) throw new NotFoundException('Holiday preset not found');
    await this.prisma.schoolHolidayPreset.delete({ where: { id } });
  }

  async applyHolidayPresetToCalendar(schoolId: string, id: string) {
    const preset = await this.prisma.schoolHolidayPreset.findFirst({ where: { id, schoolId } });
    if (!preset) throw new NotFoundException('Holiday preset not found');
    return this.prisma.event.create({
      data: {
        schoolId,
        title: preset.name,
        description: `Holiday: ${preset.name}`,
        startDate: preset.startDate,
        endDate: preset.endDate,
        type: EventType.HOLIDAY,
        isAllDay: true,
      },
    });
  }

  // --- Role templates ---
  async createRoleTemplate(schoolId: string, dto: CreateRoleTemplateDto) {
    return this.prisma.roleTemplate.create({
      data: { schoolId, ...dto },
    });
  }

  async updateRoleTemplate(schoolId: string, id: string, dto: UpdateRoleTemplateDto) {
    const tpl = await this.prisma.roleTemplate.findFirst({ where: { id, schoolId } });
    if (!tpl) throw new NotFoundException('Role template not found');
    return this.prisma.roleTemplate.update({ where: { id }, data: dto });
  }

  async deleteRoleTemplate(schoolId: string, id: string) {
    const tpl = await this.prisma.roleTemplate.findFirst({ where: { id, schoolId } });
    if (!tpl) throw new NotFoundException('Role template not found');
    if (tpl.isSystem) throw new BadRequestException('Cannot delete system role template');
    await this.prisma.roleTemplate.delete({ where: { id } });
  }

  async applyRoleTemplate(schoolId: string, templateId: string, adminId: string) {
    const tpl = await this.prisma.roleTemplate.findFirst({ where: { id: templateId, schoolId } });
    if (!tpl) throw new NotFoundException('Role template not found');
    const admin = await this.prisma.schoolAdmin.findFirst({ where: { id: adminId, schoolId } });
    if (!admin) throw new NotFoundException('Admin not found');
    await this.prisma.staffPermission.deleteMany({ where: { adminId } });
    if (tpl.permissionIds.length) {
      await this.prisma.staffPermission.createMany({
        data: tpl.permissionIds.map((permissionId) => ({ adminId, permissionId })),
        skipDuplicates: true,
      });
    }
    return { adminId, permissionIds: tpl.permissionIds };
  }

  // --- Assessment templates ---
  async createAssessmentTemplate(schoolId: string, dto: CreateAssessmentTemplateDto) {
    return this.prisma.assessmentTemplate.create({ data: { schoolId, ...dto } });
  }

  async updateAssessmentTemplate(schoolId: string, id: string, dto: UpdateAssessmentTemplateDto) {
    const tpl = await this.prisma.assessmentTemplate.findFirst({ where: { id, schoolId } });
    if (!tpl) throw new NotFoundException('Assessment template not found');
    return this.prisma.assessmentTemplate.update({ where: { id }, data: dto });
  }

  async deleteAssessmentTemplate(schoolId: string, id: string) {
    const tpl = await this.prisma.assessmentTemplate.findFirst({ where: { id, schoolId } });
    if (!tpl) throw new NotFoundException('Assessment template not found');
    await this.prisma.assessmentTemplate.update({ where: { id }, data: { isActive: false } });
  }

  // --- Fee categories & schedules ---
  async createFeeCategory(schoolId: string, dto: CreateFeeCategoryDto) {
    return this.prisma.feeCategory.create({ data: { schoolId, ...dto } });
  }

  async updateFeeCategory(schoolId: string, id: string, dto: UpdateFeeCategoryDto) {
    const cat = await this.prisma.feeCategory.findFirst({ where: { id, schoolId } });
    if (!cat) throw new NotFoundException('Fee category not found');
    return this.prisma.feeCategory.update({ where: { id }, data: dto });
  }

  async createFeeSchedule(schoolId: string, dto: CreateFeeScheduleDto) {
    return this.prisma.feeSchedule.create({
      data: {
        schoolId,
        categoryId: dto.categoryId,
        classLevelId: dto.classLevelId,
        termId: dto.termId,
        amount: dto.amount,
        dueDate: new Date(dto.dueDate),
        lateGraceDays: dto.lateGraceDays ?? 0,
        latePenaltyPercent: dto.latePenaltyPercent ?? 0,
      },
    });
  }

  async updateFeeSchedule(schoolId: string, id: string, dto: UpdateFeeScheduleDto) {
    const sched = await this.prisma.feeSchedule.findFirst({ where: { id, schoolId } });
    if (!sched) throw new NotFoundException('Fee schedule not found');
    return this.prisma.feeSchedule.update({
      where: { id },
      data: {
        ...dto,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
      },
    });
  }

  async generateFeesFromSchedule(schoolId: string, scheduleId: string) {
    const schedule = await this.prisma.feeSchedule.findFirst({
      where: { id: scheduleId, schoolId },
      include: { category: true },
    });
    if (!schedule) throw new NotFoundException('Fee schedule not found');

    const enrollments = await this.prisma.enrollment.findMany({
      where: {
        schoolId,
        ...(schedule.termId ? { termId: schedule.termId } : {}),
        isActive: true,
        ...(schedule.classLevelId
          ? {
              classArm: { classLevelId: schedule.classLevelId },
            }
          : {}),
      },
    });

    const created = await this.prisma.$transaction(
      enrollments.map((enrollment) =>
        this.prisma.fee.create({
          data: {
            enrollmentId: enrollment.id,
            schoolId,
            description: schedule.category.name,
            amount: schedule.amount,
            dueDate: schedule.dueDate,
            feeScheduleId: schedule.id,
            status: 'PENDING',
          },
        })
      )
    );
    return { count: created.length };
  }

  // --- Knowledge base ---
  async createKnowledgeDocument(schoolId: string, dto: CreateKnowledgeDocumentDto) {
    const chunk = await this.prisma.knowledgeChunk.create({
      data: {
        schoolId,
        content: dto.content,
        metadata: {
          type: 'POLICY',
          title: dto.title,
          source: dto.source ?? 'UPLOAD',
          permissions: {
            roles: ['SUPER_ADMIN', 'SCHOOL_ADMIN', 'TEACHER', 'STUDENT'],
            isPublic: true,
          },
        },
      },
    });
    await this.vectorQueue.add(
      JOB_GENERATE_EMBEDDING,
      { chunkId: chunk.id },
      { removeOnComplete: true, removeOnFail: { count: 100 } },
    );
    return chunk;
  }

  async deleteKnowledgeDocument(schoolId: string, id: string) {
    const chunk = await this.prisma.knowledgeChunk.findFirst({ where: { id, schoolId } });
    if (!chunk) throw new NotFoundException('Knowledge document not found');
    await this.prisma.knowledgeChunk.delete({ where: { id } });
  }

  // --- Policy getters for enforcement in other services ---
  async getGradingPolicy(schoolId: string) {
    await this.ensureDefaults(schoolId);
    return this.prisma.gradingPolicy.findUniqueOrThrow({ where: { schoolId } });
  }

  async getAdmissionPolicy(schoolId: string) {
    await this.ensureDefaults(schoolId);
    return this.prisma.admissionPolicy.findUniqueOrThrow({ where: { schoolId } });
  }

  async getTimetablePolicy(schoolId: string) {
    await this.ensureDefaults(schoolId);
    return this.prisma.timetablePolicy.findUniqueOrThrow({ where: { schoolId } });
  }

  async getAttendancePolicy(schoolId: string) {
    await this.ensureDefaults(schoolId);
    return this.prisma.attendancePolicy.findUniqueOrThrow({ where: { schoolId } });
  }

  async getNotificationPolicy(schoolId: string) {
    await this.ensureDefaults(schoolId);
    return this.prisma.notificationPolicy.findUniqueOrThrow({ where: { schoolId } });
  }

  async getCurriculumPolicy(schoolId: string) {
    await this.ensureDefaults(schoolId);
    return this.prisma.curriculumPolicy.findUniqueOrThrow({ where: { schoolId } });
  }

  async getSecurityPolicy(schoolId: string) {
    await this.ensureDefaults(schoolId);
    return this.prisma.securityPolicy.findUniqueOrThrow({ where: { schoolId } });
  }

  async getStructureConfig(schoolId: string) {
    await this.ensureDefaults(schoolId);
    return this.prisma.schoolStructureConfig.findUniqueOrThrow({ where: { schoolId } });
  }

  async getBellScheduleForType(schoolId: string, schoolType: string) {
    const tpl = await this.prisma.bellScheduleTemplate.findFirst({
      where: { schoolId, schoolType, isDefault: true },
    });
    return tpl;
  }

  async getWorkingDays(schoolId: string) {
    const school = await this.prisma.school.findUniqueOrThrow({
      where: { id: schoolId },
      select: { workingDays: true },
    });
    return school.workingDays;
  }

  /** Non-sensitive policy subset for teacher/student/admin UIs. */
  async getRuntimePolicies(schoolId: string): Promise<RuntimePolicies> {
    await this.ensureDefaults(schoolId);
    const [school, structure, grading, attendance, timetable, bellScheduleTemplates, assessmentTemplates] =
      await Promise.all([
        this.prisma.school.findUniqueOrThrow({
          where: { id: schoolId },
          select: { workingDays: true },
        }),
        this.prisma.schoolStructureConfig.findUniqueOrThrow({ where: { schoolId } }),
        this.prisma.gradingPolicy.findUniqueOrThrow({ where: { schoolId } }),
        this.prisma.attendancePolicy.findUniqueOrThrow({ where: { schoolId } }),
        this.prisma.timetablePolicy.findUniqueOrThrow({ where: { schoolId } }),
        this.prisma.bellScheduleTemplate.findMany({
          where: { schoolId, isDefault: true },
        }),
        this.prisma.assessmentTemplate.findMany({
          where: { schoolId, isActive: true },
          orderBy: { sequence: 'asc' },
        }),
      ]);

    const toNum = (v: unknown, fallback: number) => {
      if (v == null) return fallback;
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    };

    return {
      workingDays: school.workingDays?.length
        ? school.workingDays
        : ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'],
      terminologyOverrides: (structure.terminologyOverrides as Record<string, string> | null) ?? null,
      facultyStructureVisible: structure.facultyStructureVisible,
      teacherScope: structure.teacherScope,
      subjectRegistryMode: structure.subjectRegistryMode,
      defaultClassArmNames: structure.defaultClassArmNames?.length
        ? structure.defaultClassArmNames
        : ['A', 'B', 'C'],
      classLevelNamingMode: structure.classLevelNamingMode,
      attendanceStatusOptions: attendance.statusOptions?.length
        ? attendance.statusOptions
        : ['PRESENT', 'ABSENT', 'LATE', 'EXCUSED', 'SICK'],
      grading: {
        gradeScaleType: grading.gradeScaleType,
        passMark: toNum(grading.passMark, 40),
        defaultCaWeight: toNum(grading.defaultCaWeight, 40),
        defaultExamWeight: toNum(grading.defaultExamWeight, 60),
        templatesMode: grading.templatesMode,
        defaultAllowLateSubmissionAfterDue: grading.defaultAllowLateSubmissionAfterDue,
        defaultAllowLateSubmissionAfterTimer: grading.defaultAllowLateSubmissionAfterTimer,
        defaultLateDuePenalty: toNum(grading.defaultLateDuePenalty, 0),
        defaultLateTimerPenalty: toNum(grading.defaultLateTimerPenalty, 0),
        defaultIntegrityEnabled: grading.defaultIntegrityEnabled,
        defaultViolationThreshold: grading.defaultViolationThreshold,
        defaultPointsPerViolation: toNum(grading.defaultPointsPerViolation, 0),
        templates: assessmentTemplates.map((t) => ({
          id: t.id,
          name: t.name,
          gradeType: t.gradeType,
          maxScore: toNum(t.maxScore, 100),
          weight: t.weight != null ? Number(t.weight) : null,
          sequence: t.sequence,
        })),
      },
      timetable: {
        defaultPeriodLengthMinutes: timetable.defaultPeriodLengthMinutes,
        maxPeriodsPerTeacherPerDay: timetable.maxPeriodsPerTeacherPerDay,
        roomCapacityWarningEnabled: timetable.roomCapacityWarningEnabled,
        examBlackoutEnabled: timetable.examBlackoutEnabled,
      },
      bellScheduleTemplates: bellScheduleTemplates.map((t) => ({
        schoolType: t.schoolType,
        periods: t.periods,
        isDefault: t.isDefault,
      })),
    };
  }

  async logStudentRecordAudit(params: {
    schoolId: string;
    userId?: string;
    studentId?: string;
    action: string;
    resource?: string;
    ipAddress?: string;
  }) {
    return this.prisma.studentRecordAudit.create({ data: params });
  }

  async getAuditLogs(schoolId: string, limit = 50) {
    const [profileAudits, studentAudits] = await Promise.all([
      this.prisma.schoolProfileEditTokenAudit.findMany({
        where: { schoolId },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      this.prisma.studentRecordAudit.findMany({
        where: { schoolId },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
    ]);
    return { profileAudits, studentAudits };
  }
}
