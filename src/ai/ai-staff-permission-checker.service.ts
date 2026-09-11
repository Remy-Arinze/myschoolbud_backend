import { ForbiddenException, Injectable } from '@nestjs/common';
import {
  PermissionResource,
  PermissionType,
  isPrincipalRole,
} from '../schools/dto/permission.dto';
import { PrismaService } from '../database/prisma.service';
import {
  ALL_LOIS_INSIGHT_TYPES,
  INSIGHT_ACCESS,
  isLoisInsightType,
  type LoisInsightType,
} from './lois-insight-access';
import {
  ADMIN_GRAPH_WORKERS,
  TEACHER_GRAPH_WORKERS,
  WORKER_TOOL_NAMES,
  type LoisWorker,
} from './lois-workers';

const STUDENT_BLOCKED_TOOLS = [
  'get_school_stats',
  'get_academic_risk_summary',
  'list_students',
  'list_classes',
  'get_student_overview',
  'get_class_performance',
  'get_now_in_class',
  'list_staff',
  'who_teaches',
  'get_attendance_summary',
  'list_fee_debtors',
  'list_admissions',
  'get_calendar',
  'get_guardians',
  'list_lois_insights',
  'draft_parent_message',
  'generate_assessment',
  'grade_essay',
  'inspect_scheduling_context',
  'inspect_curriculum_options',
  'propose_timetable',
  'propose_scheme',
  'apply_pending_plans',
];

const TEACHER_BLOCKED_TOOLS = [
  'list_lois_insights',
  'list_fee_debtors',
  'list_admissions',
  'propose_timetable',
  'propose_scheme',
  'apply_pending_plans',
];

/**
 * Hierarchical staff permission checks (aligned with {@link PermissionGuard}).
 * Used by Lois tool execution so school admins cannot bypass route intent via the model.
 */
@Injectable()
export class AiStaffPermissionCheckerService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Enforces staff permissions for Lois agent tools (school admins).
   * Teachers and students are handled separately; SUPER_ADMIN is allowed for all tools.
   */
  async assertLoisToolAllowed(params: {
    toolName: string;
    userRole?: string;
    userId?: string;
    schoolId?: string;
  }): Promise<void> {
    const { toolName, userRole, userId, schoolId } = params;

    if (userRole === 'SUPER_ADMIN') {
      return;
    }
    if (userRole === 'TEACHER') {
      if (TEACHER_BLOCKED_TOOLS.includes(toolName)) {
        throw new ForbiddenException(
          toolName === 'list_lois_insights'
            ? 'School insights are available to school administrators.'
            : 'This assistant action is available to school administrators.',
        );
      }
      return;
    }
    if (userRole === 'STUDENT') {
      if (STUDENT_BLOCKED_TOOLS.includes(toolName)) {
        throw new ForbiddenException('This assistant action is not available for students.');
      }
      return;
    }
    if (userRole !== 'SCHOOL_ADMIN' || !userId || !schoolId) {
      throw new ForbiddenException('School context is required for this assistant action.');
    }

    const admin = await this.prisma.schoolAdmin.findFirst({
      where: { userId, schoolId },
      select: { id: true, role: true },
    });
    if (!admin) {
      throw new ForbiddenException('School admin profile not found for this school.');
    }
    if (isPrincipalRole(admin.role)) {
      return;
    }

    const id = admin.id;
    switch (toolName) {
      case 'search_semantic':
        if (!(await this.schoolAdminHasPermission(id, PermissionResource.OVERVIEW, PermissionType.READ))) {
          throw new ForbiddenException('You need Overview (read) access to search the knowledge base.');
        }
        return;
      case 'get_school_stats':
        if (
          !(await this.schoolAdminHasAny(id, [
            { resource: PermissionResource.OVERVIEW, type: PermissionType.READ },
            { resource: PermissionResource.ANALYTICS, type: PermissionType.READ },
          ]))
        ) {
          throw new ForbiddenException(
            'You need Overview or Analytics (read) access to view school statistics.',
          );
        }
        return;
      case 'list_lois_insights':
        // Any school admin may call this; results are filtered to types they can see.
        return;
      case 'list_students':
      case 'get_student_overview':
      case 'get_guardians':
        if (!(await this.schoolAdminHasPermission(id, PermissionResource.STUDENTS, PermissionType.READ))) {
          throw new ForbiddenException('You need Students (read) access to look up student records.');
        }
        return;
      case 'list_classes':
        if (!(await this.schoolAdminHasPermission(id, PermissionResource.CLASSES, PermissionType.READ))) {
          throw new ForbiddenException('You need Classes (read) access to list classes.');
        }
        return;
      case 'list_staff':
        if (!(await this.schoolAdminHasPermission(id, PermissionResource.STAFF, PermissionType.READ))) {
          throw new ForbiddenException('You need Staff (read) access to list staff.');
        }
        return;
      case 'who_teaches':
        if (
          !(await this.schoolAdminHasAny(id, [
            { resource: PermissionResource.STAFF, type: PermissionType.READ },
            { resource: PermissionResource.CLASSES, type: PermissionType.READ },
            { resource: PermissionResource.TIMETABLES, type: PermissionType.READ },
          ]))
        ) {
          throw new ForbiddenException('You need Staff, Classes, or Timetables (read) to look up who teaches.');
        }
        return;
      case 'get_class_performance':
      case 'get_academic_risk_summary':
        if (
          !(await this.schoolAdminHasAny(id, [
            { resource: PermissionResource.GRADES, type: PermissionType.READ },
            { resource: PermissionResource.ANALYTICS, type: PermissionType.READ },
          ]))
        ) {
          throw new ForbiddenException(
            'You need Grades or Analytics (read) access to view academic performance.',
          );
        }
        return;
      case 'get_scheme_of_work':
        if (
          !(await this.schoolAdminHasAny(id, [
            { resource: PermissionResource.SCHEME_OF_WORK, type: PermissionType.READ },
            { resource: PermissionResource.CURRICULUM, type: PermissionType.READ },
          ]))
        ) {
          throw new ForbiddenException('You need Curriculum or Scheme of Work (read) access.');
        }
        return;
      case 'get_now_in_class':
      case 'get_timetable':
        if (!(await this.schoolAdminHasPermission(id, PermissionResource.TIMETABLES, PermissionType.READ))) {
          throw new ForbiddenException('You need Timetables (read) access to view the timetable.');
        }
        return;
      case 'list_fee_debtors':
        if (
          !(await this.schoolAdminHasAny(id, [
            { resource: PermissionResource.SETTINGS, type: PermissionType.READ },
            { resource: PermissionResource.STUDENTS, type: PermissionType.READ },
          ]))
        ) {
          throw new ForbiddenException(
            'You need Settings or Students (read) access to view outstanding fees.',
          );
        }
        return;
      case 'list_admissions':
        if (!(await this.schoolAdminHasPermission(id, PermissionResource.ADMISSIONS, PermissionType.READ))) {
          throw new ForbiddenException('You need Admissions (read) access to view applications.');
        }
        return;
      case 'get_calendar':
        if (
          !(await this.schoolAdminHasAny(id, [
            { resource: PermissionResource.EVENTS, type: PermissionType.READ },
            { resource: PermissionResource.CALENDAR, type: PermissionType.READ },
          ]))
        ) {
          throw new ForbiddenException('You need Calendar or Events (read) access.');
        }
        return;
      case 'get_attendance_summary':
        if (
          !(await this.schoolAdminHasAny(id, [
            { resource: PermissionResource.STUDENTS, type: PermissionType.READ },
            { resource: PermissionResource.ANALYTICS, type: PermissionType.READ },
          ]))
        ) {
          throw new ForbiddenException('You need Students or Analytics (read) access for attendance.');
        }
        return;
      case 'draft_parent_message':
        if (!(await this.schoolAdminHasPermission(id, PermissionResource.STUDENTS, PermissionType.READ))) {
          throw new ForbiddenException('You need Students (read) access to draft parent messages.');
        }
        return;
      case 'inspect_scheduling_context':
        if (!(await this.schoolAdminHasPermission(id, PermissionResource.TIMETABLES, PermissionType.READ))) {
          throw new ForbiddenException('You need Timetables (read) access to inspect scheduling.');
        }
        return;
      case 'inspect_curriculum_options':
        if (
          !(await this.schoolAdminHasAny(id, [
            { resource: PermissionResource.CURRICULUM, type: PermissionType.READ },
            { resource: PermissionResource.SCHEME_OF_WORK, type: PermissionType.READ },
          ]))
        ) {
          throw new ForbiddenException('You need Curriculum or Scheme of Work (read) access.');
        }
        return;
      case 'propose_timetable':
        if (!(await this.schoolAdminHasPermission(id, PermissionResource.TIMETABLES, PermissionType.WRITE))) {
          throw new ForbiddenException('You need Timetables (write) access to propose a timetable.');
        }
        return;
      case 'propose_scheme':
        if (
          !(await this.schoolAdminHasAny(id, [
            { resource: PermissionResource.CURRICULUM, type: PermissionType.WRITE },
            { resource: PermissionResource.SCHEME_OF_WORK, type: PermissionType.WRITE },
          ]))
        ) {
          throw new ForbiddenException('You need Curriculum or Scheme of Work (write) access to propose a scheme.');
        }
        return;
      case 'apply_pending_plans':
        return;
      case 'grade_essay':
        if (!(await this.schoolAdminHasPermission(id, PermissionResource.GRADES, PermissionType.READ))) {
          throw new ForbiddenException('You need Grades (read) access to use essay grading.');
        }
        return;
      case 'generate_lesson_plan':
      case 'generate_quiz':
      case 'generate_flashcards':
      case 'generate_summary':
      case 'generate_assessment':
        if (!(await this.schoolAdminHasPermission(id, PermissionResource.CURRICULUM, PermissionType.READ))) {
          throw new ForbiddenException('You need Curriculum (read) access to generate this content.');
        }
        return;
      default:
        return;
    }
  }

  /** WRITE check for HTTP apply of a stored Lois plan (not a chat tool). */
  async assertLoisPlanWrite(params: {
    kind: 'TIMETABLE' | 'SCHEME';
    userRole?: string;
    userId?: string;
    schoolId?: string;
  }): Promise<void> {
    const { kind, userRole, userId, schoolId } = params;
    if (userRole === 'SUPER_ADMIN') return;
    if (userRole === 'TEACHER' || userRole === 'STUDENT') {
      throw new ForbiddenException('Applying a Lois plan is available to school administrators.');
    }
    if (userRole !== 'SCHOOL_ADMIN' || !userId || !schoolId) {
      throw new ForbiddenException('School context is required to apply this plan.');
    }

    const admin = await this.prisma.schoolAdmin.findFirst({
      where: { userId, schoolId },
      select: { id: true, role: true },
    });
    if (!admin) {
      throw new ForbiddenException('School admin profile not found for this school.');
    }
    if (isPrincipalRole(admin.role)) return;

    if (kind === 'TIMETABLE') {
      if (!(await this.schoolAdminHasPermission(admin.id, PermissionResource.TIMETABLES, PermissionType.WRITE))) {
        throw new ForbiddenException('You need Timetables (write) access to apply this timetable.');
      }
      return;
    }

    if (
      !(await this.schoolAdminHasAny(admin.id, [
        { resource: PermissionResource.CURRICULUM, type: PermissionType.WRITE },
        { resource: PermissionResource.SCHEME_OF_WORK, type: PermissionType.WRITE },
      ]))
    ) {
      throw new ForbiddenException('You need Curriculum or Scheme of Work (write) access to apply this scheme.');
    }
  }

  async schoolAdminHasPermission(
    adminId: string,
    resource: PermissionResource,
    requiredType: PermissionType,
  ): Promise<boolean> {
    const hasAdminOnResource = await this.prisma.staffPermission.findFirst({
      where: {
        adminId,
        permission: { resource, type: PermissionType.ADMIN },
      },
    });
    if (hasAdminOnResource) return true;

    const allowedTypes: PermissionType[] = [PermissionType.ADMIN];
    if (requiredType === PermissionType.WRITE) {
      allowedTypes.push(PermissionType.WRITE);
    } else if (requiredType === PermissionType.READ) {
      allowedTypes.push(PermissionType.WRITE, PermissionType.READ);
    }

    const row = await this.prisma.staffPermission.findFirst({
      where: {
        adminId,
        permission: { resource, type: { in: allowedTypes } },
      },
    });
    return !!row;
  }

  async schoolAdminHasAny(
    adminId: string,
    alternatives: { resource: PermissionResource; type: PermissionType }[],
  ): Promise<boolean> {
    for (const alt of alternatives) {
      if (await this.schoolAdminHasPermission(adminId, alt.resource, alt.type)) {
        return true;
      }
    }
    return false;
  }

  async canSeeInsightType(adminId: string, role: string | null | undefined, type: string): Promise<boolean> {
    if (!isLoisInsightType(type)) return false;
    if (isPrincipalRole(role)) return true;
    return this.schoolAdminHasAny(adminId, INSIGHT_ACCESS[type]);
  }

  /**
   * Insight types this user is allowed to see for a school.
   * Principals and super admins see every type; others match staff permissions.
   */
  async allowedInsightTypes(
    userId: string | undefined,
    schoolId: string | undefined,
    userRole?: string,
  ): Promise<LoisInsightType[]> {
    if (userRole === 'SUPER_ADMIN') {
      return [...ALL_LOIS_INSIGHT_TYPES];
    }
    if (userRole !== 'SCHOOL_ADMIN' || !userId || !schoolId) {
      return [];
    }

    const admin = await this.prisma.schoolAdmin.findFirst({
      where: { userId, schoolId },
      select: { id: true, role: true },
    });
    if (!admin) return [];
    if (isPrincipalRole(admin.role)) {
      return [...ALL_LOIS_INSIGHT_TYPES];
    }

    const allowed: LoisInsightType[] = [];
    for (const type of ALL_LOIS_INSIGHT_TYPES) {
      if (await this.schoolAdminHasAny(admin.id, INSIGHT_ACCESS[type])) {
        allowed.push(type);
      }
    }
    return allowed;
  }

  /** School-admin user ids who should be notified for a given insight type. */
  async getAdminUserIdsForInsightType(schoolId: string, type: LoisInsightType): Promise<string[]> {
    const admins = await this.prisma.schoolAdmin.findMany({
      where: { schoolId },
      select: { id: true, userId: true, role: true },
    });

    const userIds: string[] = [];
    for (const admin of admins) {
      if (await this.canSeeInsightType(admin.id, admin.role, type)) {
        userIds.push(admin.userId);
      }
    }
    return userIds;
  }

  /**
   * Workers this user may have compiled into the Lois graph.
   * Omits desks (curator, finance, …) whose tools would all fail permission checks.
   */
  async resolveAllowedWorkers(params: {
    userRole?: string;
    userId?: string;
    schoolId?: string;
  }): Promise<LoisWorker[]> {
    const { userRole, userId, schoolId } = params;

    if (userRole === 'STUDENT') return [];
    if (userRole === 'TEACHER') return [...TEACHER_GRAPH_WORKERS];
    if (userRole === 'SUPER_ADMIN') return [...ADMIN_GRAPH_WORKERS];
    if (userRole !== 'SCHOOL_ADMIN' || !userId || !schoolId) return [];

    const allowed: LoisWorker[] = [];
    for (const worker of ADMIN_GRAPH_WORKERS) {
      if (await this.workerHasAnyPermittedTool(WORKER_TOOL_NAMES[worker], userRole, userId, schoolId)) {
        allowed.push(worker);
      }
    }
    return allowed;
  }

  private async workerHasAnyPermittedTool(
    toolNames: readonly string[],
    userRole: string,
    userId: string,
    schoolId: string,
  ): Promise<boolean> {
    for (const toolName of toolNames) {
      try {
        await this.assertLoisToolAllowed({ toolName, userRole, userId, schoolId });
        return true;
      } catch {
        // try next tool in the desk
      }
    }
    return false;
  }
}
