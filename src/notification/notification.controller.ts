import { Controller, Get, Param, Req, Res, Logger, UnauthorizedException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { OnEvent } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { Response, Request } from 'express';
import { 
    SubmissionNotificationPayload, 
    AssessmentPublishedPayload, 
    GradePublishedPayload,
    AgoraSubjectAddedPayload,
    StudentReassignedPayload,
    AcademicRiskDigestPayload,
    SubscriptionBillingReminderPayload,
} from './notification.service';
import { PrismaService } from '../database/prisma.service';

/**
 * SSE-based notification controller.
 * Supports both Teachers and Students.
 * 
 * NOTE: We skip the standard JwtAuthGuard here because EventSource (SSE)
 * cannot set custom HTTP headers. Instead, we extract the JWT from the
 * query parameter and validate it manually via JwtService.
 */
@ApiTags('Notifications')
@Controller('schools/:schoolId/notifications')
export class NotificationController {
    private readonly logger = new Logger(NotificationController.name);

    // Map of profileId -> Set of SSE Response objects
    private readonly teacherConnections = new Map<string, Set<Response>>();
    private readonly studentConnections = new Map<string, Set<Response>>();

    constructor(
        private readonly prisma: PrismaService,
        private readonly jwtService: JwtService,
    ) {}

    /**
     * Validate a JWT token from query parameter and return the user payload.
     */
    private async validateToken(token: string) {
        try {
            const payload = this.jwtService.verify(token);
            const user = await this.prisma.user.findUnique({
                where: { id: payload.sub },
                select: { id: true, role: true },
            });

            if (!user) throw new UnauthorizedException();

            return {
                ...user,
                currentProfileId: payload.profileId,
            };
        } catch {
            throw new UnauthorizedException('Invalid or expired token');
        }
    }

    @SkipThrottle()
    @Get('stream')
    @ApiOperation({ summary: 'SSE stream for real-time teacher notifications' })
    async stream(
        @Req() req: Request,
        @Param('schoolId') schoolId: string,
        @Res() res: Response,
    ) {
        // Manually authenticate via query parameter
        const token = req.query.token as string;
        if (!token) {
            res.status(401).json({ message: 'Missing authentication token' });
            return;
        }

        let user: any;
        try {
            user = await this.validateToken(token);
        } catch {
            res.status(401).json({ message: 'Invalid authentication token' });
            return;
        }

        // SSE headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        // Send initial connected event
        res.write(`event: connected\ndata: ${JSON.stringify({ message: 'Notification stream connected' })}\n\n`);

        if (user.role === 'TEACHER' || user.role === 'SCHOOL_ADMIN') {
            // Resolve the teacher's profile ID
            const teacher = await this.prisma.teacher.findFirst({
                where: { userId: user.id, schoolId },
                select: { id: true },
            });
            const profileId = teacher?.id || user.id;

            if (!this.teacherConnections.has(profileId)) {
                this.teacherConnections.set(profileId, new Set());
            }
            this.teacherConnections.get(profileId)!.add(res);
            // Always also register by userId so inbox.created reaches school admins
            if (profileId !== user.id) {
                if (!this.teacherConnections.has(user.id)) {
                    this.teacherConnections.set(user.id, new Set());
                }
                this.teacherConnections.get(user.id)!.add(res);
            }
            this.logger.log(`SSE teacher/admin notification stream opened: ${profileId} (user ${user.id})`);

            req.on('close', () => {
                this.teacherConnections.get(profileId)?.delete(res);
                if (this.teacherConnections.get(profileId)?.size === 0) {
                    this.teacherConnections.delete(profileId);
                }
                if (profileId !== user.id) {
                    this.teacherConnections.get(user.id)?.delete(res);
                    if (this.teacherConnections.get(user.id)?.size === 0) {
                        this.teacherConnections.delete(user.id);
                    }
                }
            });
        } else if (user.role === 'STUDENT') {
            const student = await this.prisma.student.findUnique({
                where: { userId: user.id },
                select: { id: true },
            });
            const profileId = student?.id;

            if (profileId) {
                if (!this.studentConnections.has(profileId)) {
                    this.studentConnections.set(profileId, new Set());
                }
                this.studentConnections.get(profileId)!.add(res);
                this.logger.log(`SSE student notification stream opened: ${profileId}`);

                req.on('close', () => {
                    this.studentConnections.get(profileId)?.delete(res);
                    if (this.studentConnections.get(profileId)?.size === 0) {
                        this.studentConnections.delete(profileId);
                    }
                });
            }
        }

        // Heartbeat every 30 seconds
        const heartbeat = setInterval(() => {
            try {
                res.write(`:heartbeat\n\n`);
            } catch {
                clearInterval(heartbeat);
            }
        }, 30000);

        req.on('close', () => {
            clearInterval(heartbeat);
            this.logger.log(`SSE notification stream closed for user ${user.id}`);
        });
    }

    @OnEvent('assessment.submitted')
    handleSubmissionEvent(payload: SubmissionNotificationPayload) {
        const connections = this.teacherConnections.get(payload.teacherId);
        if (!connections || connections.size === 0) return;

        const eventData = JSON.stringify({
            type: 'ASSESSMENT_SUBMITTED',
            studentName: payload.studentName,
            assessmentTitle: payload.assessmentTitle,
            subjectName: payload.subjectName,
            assessmentId: payload.assessmentId,
            submissionId: payload.submissionId,
            timestamp: payload.timestamp,
        });

        connections.forEach((res) => {
            try { res.write(`event: notification\ndata: ${eventData}\n\n`); }
            catch (err) { this.logger.warn(`Failed to write SSE event: ${err}`); }
        });
    }

    @OnEvent('assessment.published')
    async handleAssessmentPublished(payload: AssessmentPublishedPayload) {
        // Find all students in this class/arm
        const students = await this.prisma.student.findMany({
            where: {
                enrollments: {
                    some: {
                        isActive: true,
                        OR: [
                            { classId: payload.classId },
                            { classArmId: payload.classArmId }
                        ]
                    }
                }
            },
            select: { id: true }
        });

        const studentIds = students.map(s => s.id);
        const eventData = JSON.stringify({
            type: 'ASSESSMENT_PUBLISHED',
            assessmentTitle: payload.assessmentTitle,
            subjectName: payload.subjectName,
            assessmentId: payload.assessmentId,
            teacherName: payload.teacherName,
            timestamp: payload.timestamp,
        });

        studentIds.forEach(profileId => {
            const connections = this.studentConnections.get(profileId);
            if (connections) {
                connections.forEach(res => {
                    try { res.write(`event: notification\ndata: ${eventData}\n\n`); }
                    catch (err) { }
                });
            }
        });
    }

    @OnEvent('grade.published')
    handleGradePublished(payload: GradePublishedPayload) {
        const connections = this.studentConnections.get(payload.studentId);
        if (!connections || connections.size === 0) return;

        const eventData = JSON.stringify({
            type: 'GRADE_PUBLISHED',
            assessmentTitle: payload.assessmentTitle,
            subjectName: payload.subjectName,
            score: payload.score,
            maxScore: payload.maxScore,
            timestamp: payload.timestamp,
        });

        connections.forEach(res => {
            try { res.write(`event: notification\ndata: ${eventData}\n\n`); }
            catch (err) { }
        });
    }

    @OnEvent('agora.subject.added')
    handleAgoraSubjectAdded(payload: AgoraSubjectAddedPayload) {
        this.logger.log(`Broadcasting new Agora subject: ${payload.subjectName}`);
        
        const eventData = JSON.stringify({
            type: 'AGORA_SUBJECT_ADDED',
            subjectId: payload.subjectId,
            subjectName: payload.subjectName,
            subjectCode: payload.subjectCode,
            schoolTypes: payload.schoolTypes,
            timestamp: payload.timestamp,
        });

        // Broadcast to all connected teachers and school admins
        this.teacherConnections.forEach((connections) => {
            connections.forEach((res) => {
                try { res.write(`event: notification\ndata: ${eventData}\n\n`); }
                catch (err) { }
            });
        });
    }

    @OnEvent('academic.risk.digest')
    async handleAcademicRiskDigest(payload: AcademicRiskDigestPayload) {
        const admins = await this.prisma.schoolAdmin.findMany({
            where: { schoolId: payload.schoolId },
            select: { userId: true },
        });

        const eventData = JSON.stringify({
            type: 'ACADEMIC_RISK_DIGEST',
            schoolId: payload.schoolId,
            schoolName: payload.schoolName,
            atRiskCount: payload.atRiskCount,
            preview: payload.preview,
            timestamp: payload.timestamp,
        });

        for (const { userId } of admins) {
            const teacher = await this.prisma.teacher.findFirst({
                where: { userId, schoolId: payload.schoolId },
                select: { id: true },
            });
            const profileId = teacher?.id ?? userId;
            const connections = this.teacherConnections.get(profileId);
            if (!connections?.size) continue;
            connections.forEach((res) => {
                try {
                    res.write(`event: notification\ndata: ${eventData}\n\n`);
                } catch {
                    // ignore
                }
            });
        }
    }

    @OnEvent('subscription.billing.reminder')
    async handleSubscriptionBillingReminder(payload: SubscriptionBillingReminderPayload) {
        const admins = await this.prisma.schoolAdmin.findMany({
            where: { schoolId: payload.schoolId },
            select: { userId: true },
        });

        const eventData = JSON.stringify({
            type: 'SUBSCRIPTION_BILLING_REMINDER',
            kind: payload.kind,
            schoolId: payload.schoolId,
            schoolName: payload.schoolName,
            graceEndsAt: payload.graceEndsAt,
            graceDay: payload.graceDay,
            timestamp: payload.timestamp,
        });

        for (const { userId } of admins) {
            const teacher = await this.prisma.teacher.findFirst({
                where: { userId, schoolId: payload.schoolId },
                select: { id: true },
            });
            const profileId = teacher?.id ?? userId;
            const connections = this.teacherConnections.get(profileId);
            if (!connections?.size) continue;
            connections.forEach((res) => {
                try {
                    res.write(`event: notification\ndata: ${eventData}\n\n`);
                } catch {
                    // ignore
                }
            });
        }
    }

    @OnEvent('student.reassigned')
    handleStudentReassigned(payload: StudentReassignedPayload) {
        const eventData = JSON.stringify({
            type: 'STUDENT_REASSIGNED',
            studentId: payload.studentId,
            studentName: payload.studentName,
            oldClassName: payload.oldClassName,
            newClassName: payload.newClassName,
            adminName: payload.adminName,
            timestamp: payload.timestamp,
        });

        payload.teacherIds.forEach(profileId => {
            const connections = this.teacherConnections.get(profileId);
            if (connections) {
                connections.forEach(res => {
                    try { res.write(`event: notification\ndata: ${eventData}\n\n`); }
                    catch (err) { }
                });
            }
        });
    }

    /**
     * Live badge refresh — push inbox.created to the matching user's SSE connections.
     * School admins and teachers share teacherConnections keyed by teacher profile or userId.
     */
    @OnEvent('inbox.created')
    async handleInboxCreated(payload: { notification: { userId: string; schoolId: string | null; type: string; title: string; subtitle?: string | null; link: string | null; id: string; createdAt: string } }) {
        const n = payload.notification;
        const eventData = JSON.stringify({
            type: 'INBOX_CREATED',
            notificationId: n.id,
            title: n.title,
            subtitle: n.subtitle || '',
            link: n.link,
            notificationType: n.type,
            timestamp: n.createdAt,
        });

        const writeTo = (map: Map<string, Set<Response>>, key: string) => {
            const connections = map.get(key);
            if (!connections?.size) return;
            connections.forEach((res) => {
                try { res.write(`event: notification\ndata: ${eventData}\n\n`); }
                catch { /* ignore */ }
            });
        };

        // Direct key by userId (admins often use user.id as profileId fallback)
        writeTo(this.teacherConnections, n.userId);
        writeTo(this.studentConnections, n.userId);

        try {
            const [teacher, student, admin] = await Promise.all([
                this.prisma.teacher.findFirst({
                    where: { userId: n.userId, ...(n.schoolId ? { schoolId: n.schoolId } : {}) },
                    select: { id: true },
                }),
                this.prisma.student.findUnique({
                    where: { userId: n.userId },
                    select: { id: true },
                }),
                n.schoolId
                    ? this.prisma.schoolAdmin.findFirst({
                        where: { userId: n.userId, schoolId: n.schoolId },
                        select: { id: true },
                      })
                    : null,
            ]);
            if (teacher?.id) writeTo(this.teacherConnections, teacher.id);
            if (student?.id) writeTo(this.studentConnections, student.id);
            // Admin without teacher profile already covered via userId key above
            void admin;
        } catch {
            // ignore lookup failures
        }
    }
}
