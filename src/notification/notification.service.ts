import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotificationInboxService } from './notification-inbox.service';

export interface SubmissionNotificationPayload {
  schoolId: string;
  teacherId: string; // Teacher profile ID
  studentName: string;
  assessmentTitle: string;
  subjectName: string;
  assessmentId: string;
  submissionId: string;
  classId?: string;
  classArmId?: string;
  timestamp: string;
}

export interface AssessmentPublishedPayload {
  schoolId: string;
  classId?: string;
  classArmId?: string;
  assessmentTitle: string;
  subjectName: string;
  assessmentId: string;
  teacherName: string;
  timestamp: string;
}

export interface GradePublishedPayload {
  schoolId: string;
  studentId: string; // Student profile ID
  assessmentTitle: string;
  subjectName: string;
  score: number;
  maxScore: number;
  timestamp: string;
}

export interface AgoraSubjectAddedPayload {
  subjectId: string;
  subjectName: string;
  subjectCode: string;
  schoolTypes: string[];
  timestamp: string;
}

export interface StudentReassignedPayload {
  schoolId: string;
  studentId: string;
  studentName: string;
  oldClassArmId?: string;
  oldClassName?: string;
  newClassArmId?: string;
  newClassName?: string;
  adminName: string;
  teacherIds: string[];
  timestamp: string;
  studentUserId?: string;
}

export interface AcademicRiskDigestPayload {
  schoolId: string;
  schoolName: string;
  atRiskCount: number;
  preview: { studentName: string; avgPercent: number }[];
  timestamp: string;
}

export interface SubscriptionBillingReminderPayload {
  schoolId: string;
  schoolName: string;
  kind: 'GRACE_PERIOD' | 'ADMIN_ACTION_REQUIRED';
  graceEndsAt: string;
  graceDay: number;
  timestamp: string;
}

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly inbox: NotificationInboxService,
  ) {}

  emitSubmissionNotification(payload: SubmissionNotificationPayload) {
    this.logger.log(
      `Emitting submission notification for teacher ${payload.teacherId}: ${payload.studentName} submitted ${payload.assessmentTitle}`,
    );
    this.eventEmitter.emit('assessment.submitted', payload);
    void this.persistSubmission(payload);
  }

  emitAssessmentPublished(payload: AssessmentPublishedPayload) {
    this.logger.log(
      `Emitting assessment published notification for class ${payload.classId || payload.classArmId}: ${payload.assessmentTitle}`,
    );
    this.eventEmitter.emit('assessment.published', payload);
    void this.persistAssessmentPublished(payload);
  }

  emitGradePublished(payload: GradePublishedPayload) {
    this.logger.log(
      `Emitting grade published notification for student ${payload.studentId}: ${payload.assessmentTitle}`,
    );
    this.eventEmitter.emit('grade.published', payload);
    void this.persistGradePublished(payload);
  }

  emitAgoraSubjectAdded(payload: AgoraSubjectAddedPayload) {
    this.logger.log(
      `Emitting global subject added notification: ${payload.subjectName} (${payload.subjectCode})`,
    );
    this.eventEmitter.emit('agora.subject.added', payload);
    // Global broadcast — skip mass inbox fan-out (too noisy); SSE toast only
  }

  emitStudentReassigned(payload: StudentReassignedPayload) {
    this.logger.log(
      `Emitting student reassigned notification for ${payload.teacherIds.length} teachers: ${payload.studentName}`,
    );
    this.eventEmitter.emit('student.reassigned', payload);
    void this.persistStudentReassigned(payload);
  }

  emitAcademicRiskDigest(payload: AcademicRiskDigestPayload) {
    this.logger.log(
      `Emitting academic risk digest for school ${payload.schoolId}: ${payload.atRiskCount} student(s) below threshold`,
    );
    this.eventEmitter.emit('academic.risk.digest', payload);
    void this.persistAcademicRisk(payload);
  }

  emitSubscriptionBillingReminder(payload: SubscriptionBillingReminderPayload) {
    this.logger.log(
      `Emitting subscription billing reminder for school ${payload.schoolId} (${payload.kind}, day ${payload.graceDay})`,
    );
    this.eventEmitter.emit('subscription.billing.reminder', payload);
    void this.persistBilling(payload);
  }

  // ─── Generic helpers for domain services ─────────────────

  async notifyUsers(
    userIds: string[],
    data: {
      schoolId?: string | null;
      role?: string | null;
      type: string;
      title: string;
      subtitle?: string | null;
      body: string;
      link?: string | null;
      metadata?: Record<string, unknown> | null;
    },
  ) {
    const unique = [...new Set(userIds.filter(Boolean))];
    if (!unique.length) return;
    await this.inbox.createAndFanOut(
      unique.map((userId) => ({
        userId,
        schoolId: data.schoolId,
        role: data.role,
        type: data.type,
        title: data.title,
        subtitle: data.subtitle,
        body: data.body,
        link: data.link,
        metadata: data.metadata,
      })),
    );
  }

  async notifySchoolAdmins(
    schoolId: string,
    data: {
      type: string;
      title: string;
      subtitle?: string | null;
      body: string;
      link?: string | null;
      metadata?: Record<string, unknown> | null;
    },
  ) {
    const ids = await this.inbox.getSchoolAdminUserIds(schoolId);
    await this.notifyUsers(ids, { ...data, schoolId, role: 'SCHOOL_ADMIN' });
  }

  // ─── Persist existing SSE events ─────────────────────────

  private async persistSubmission(payload: SubmissionNotificationPayload) {
    try {
      const userId = await this.inbox.getTeacherUserId(payload.teacherId);
      if (!userId) return;
      const classTarget = payload.classArmId || payload.classId;
      await this.inbox.createAndFanOut({
        userId,
        schoolId: payload.schoolId,
        role: 'TEACHER',
        type: 'ASSESSMENT_SUBMITTED',
        title: 'New submission',
        subtitle: `${payload.studentName} · ${payload.assessmentTitle}`,
        body: `${payload.studentName} submitted ${payload.assessmentTitle} in ${payload.subjectName}. It is waiting to be graded.`,
        link: classTarget
          ? `/dashboard/teacher/classes/${classTarget}?tab=assessments`
          : `/dashboard/teacher/assessments/${payload.assessmentId}`,
        metadata: { assessmentId: payload.assessmentId, submissionId: payload.submissionId },
      });
    } catch (err: any) {
      this.logger.warn(`persistSubmission failed: ${err?.message || err}`);
    }
  }

  private async persistAssessmentPublished(payload: AssessmentPublishedPayload) {
    try {
      const userIds = await this.inbox.getStudentUserIdsInClass({
        schoolId: payload.schoolId,
        classId: payload.classId,
        classArmId: payload.classArmId,
      });
      await this.inbox.createAndFanOut(
        userIds.map((userId) => ({
          userId,
          schoolId: payload.schoolId,
          role: 'STUDENT',
          type: 'ASSESSMENT_PUBLISHED',
          title: 'New assessment',
          subtitle: payload.assessmentTitle,
          body: `${payload.assessmentTitle} in ${payload.subjectName} is ready to take.`,
          link: `/dashboard/student/classes`,
          metadata: { assessmentId: payload.assessmentId },
        })),
      );
    } catch (err: any) {
      this.logger.warn(`persistAssessmentPublished failed: ${err?.message || err}`);
    }
  }

  private async persistGradePublished(payload: GradePublishedPayload) {
    try {
      const userId = await this.inbox.getStudentUserId(payload.studentId);
      if (!userId) return;
      await this.inbox.createAndFanOut({
        userId,
        schoolId: payload.schoolId,
        role: 'STUDENT',
        type: 'GRADE_PUBLISHED',
        title: 'Grade published',
        subtitle: payload.assessmentTitle,
        body: `Your result for ${payload.assessmentTitle} in ${payload.subjectName} is ${payload.score}/${payload.maxScore}.`,
        link: `/dashboard/student/results`,
        metadata: { assessmentTitle: payload.assessmentTitle },
      });
    } catch (err: any) {
      this.logger.warn(`persistGradePublished failed: ${err?.message || err}`);
    }
  }

  private async persistStudentReassigned(payload: StudentReassignedPayload) {
    try {
      const teacherUserIds = (
        await Promise.all(payload.teacherIds.map((id) => this.inbox.getTeacherUserId(id)))
      ).filter((id): id is string => !!id);

      await this.inbox.createAndFanOut(
        teacherUserIds.map((userId) => ({
          userId,
          schoolId: payload.schoolId,
          role: 'TEACHER',
          type: 'STUDENT_REASSIGNED',
          title: 'Student moved',
          subtitle: payload.newClassName
            ? `${payload.studentName} · ${payload.newClassName}`
            : payload.studentName,
          body: payload.oldClassName && payload.newClassName
            ? `${payload.studentName} left ${payload.oldClassName} and is now in ${payload.newClassName}.`
            : `${payload.studentName} was moved${payload.newClassName ? ` to ${payload.newClassName}` : ' to another class'}.`,
          link: payload.newClassArmId
            ? `/dashboard/teacher/classes/${payload.newClassArmId}`
            : `/dashboard/teacher/classes`,
          metadata: { studentId: payload.studentId },
        })),
      );

      const studentUserId =
        payload.studentUserId || (await this.inbox.getStudentUserId(payload.studentId));
      if (studentUserId) {
        await this.inbox.createAndFanOut({
          userId: studentUserId,
          schoolId: payload.schoolId,
          role: 'STUDENT',
          type: 'CLASS_REASSIGNED',
          title: 'Class updated',
          subtitle: payload.newClassName || 'Your class',
          body: payload.newClassName
            ? `You were moved to ${payload.newClassName}.`
            : 'You were moved to a new class.',
          link: `/dashboard/student/classes`,
          metadata: { classArmId: payload.newClassArmId || null },
        });
      }
    } catch (err: any) {
      this.logger.warn(`persistStudentReassigned failed: ${err?.message || err}`);
    }
  }

  private async persistAcademicRisk(payload: AcademicRiskDigestPayload) {
    try {
      await this.notifySchoolAdmins(payload.schoolId, {
        type: 'ACADEMIC_RISK_DIGEST',
        title: 'Students need attention',
        subtitle: payload.schoolName,
        body: 'Open Lois for the briefing. Names and scores stay there.',
        link: `/dashboard/school/students`,
        metadata: { atRiskCount: payload.atRiskCount },
      });
    } catch (err: any) {
      this.logger.warn(`persistAcademicRisk failed: ${err?.message || err}`);
    }
  }

  private async persistBilling(payload: SubscriptionBillingReminderPayload) {
    try {
      const subtitle = payload.kind === 'GRACE_PERIOD' ? 'Grace period' : 'Renewal due';
      const renewBy = new Date(payload.graceEndsAt).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      });
      await this.notifySchoolAdmins(payload.schoolId, {
        type: 'SUBSCRIPTION_BILLING_REMINDER',
        title: 'Subscription',
        subtitle,
        body: `${payload.schoolName} needs a renewal before ${renewBy}.`,
        link: `/dashboard/school/subscription`,
        metadata: { kind: payload.kind },
      });
    } catch (err: any) {
      this.logger.warn(`persistBilling failed: ${err?.message || err}`);
    }
  }
}
