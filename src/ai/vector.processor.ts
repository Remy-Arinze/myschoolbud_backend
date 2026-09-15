import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../database/prisma.service';
import { AiService } from './ai.service';
import { KnowledgeEntityType } from './knowledge-events.constants';
import { MetricsService } from '../common/metrics/metrics.service';

export const VECTOR_QUEUE_NAME = '{vector}';
export const JOB_GENERATE_EMBEDDING = 'generate-embedding';
export const JOB_INDEX_RECORD = 'index-record';

export interface GenerateEmbeddingPayload {
  chunkId: string;
}

export interface IndexRecordPayload {
  type: KnowledgeEntityType;
  id: string;
}

/**
 * Processes generate-embedding jobs: load KnowledgeChunk by id, call OpenAI embedding, update row.
 * Processes index-record jobs: fetches target row, generates chunk, inserts, and queues embedding.
 * Retries with backoff on OpenAI rate limits.
 */
@Processor(VECTOR_QUEUE_NAME, {
  concurrency: 1,
})
export class VectorProcessor extends WorkerHost {
  private readonly logger = new Logger(VectorProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiService: AiService,
    private readonly metricsService: MetricsService,
  ) {
    super();
  }

  async process(job: Job<any, void, string>): Promise<void> {
    const startTime = Date.now();
    try {
      if (job.name === JOB_GENERATE_EMBEDDING) {
        await this.processGenerateEmbedding(job as Job<GenerateEmbeddingPayload, void, string>);
      } else if (job.name === JOB_INDEX_RECORD) {
        await this.processIndexRecord(job as Job<IndexRecordPayload, void, string>);
      } else {
        this.logger.warn(`Unknown job name: ${job.name}`);
      }

      const durationSec = (Date.now() - startTime) / 1000;
      this.metricsService.bullmqJobsCompletedTotal.inc({ queue: VECTOR_QUEUE_NAME, job_name: job.name });
      this.metricsService.bullmqJobDurationSeconds.observe({ queue: VECTOR_QUEUE_NAME, job_name: job.name }, durationSec);

    } catch (error) {
      this.metricsService.bullmqJobsFailedTotal.inc({ queue: VECTOR_QUEUE_NAME, job_name: job.name });
      throw error;
    }
  }

  private async processGenerateEmbedding(job: Job<GenerateEmbeddingPayload, void, string>): Promise<void> {
    const { chunkId } = job.data;
    if (!chunkId) {
      this.logger.warn('Job missing chunkId');
      return;
    }

    const chunk = await this.prisma.knowledgeChunk.findUnique({
      where: { id: chunkId },
      select: { id: true, content: true },
    });

    if (!chunk) {
      this.logger.warn(`Chunk not found: ${chunkId}`);
      return;
    }

    if (!chunk.content || chunk.content.trim() === '') {
      this.logger.debug(`Chunk ${chunkId} has no content, skipping`);
      return;
    }

    try {
      const embedding = await this.aiService.createEmbedding(chunk.content);
      const vectorString = `[${embedding.join(',')}]`;

      await this.prisma.$executeRawUnsafe(
        `UPDATE "KnowledgeChunk" SET "embedding" = $1::vector, "updatedAt" = NOW() WHERE "id" = $2`,
        vectorString,
        chunkId,
      );

      this.logger.debug(`Embedding updated for chunk ${chunkId}`);
    } catch (error: any) {
      this.logger.error(`Embedding failed for chunk ${chunkId}: ${error?.message}`);
      throw error;
    }
  }

  private async processIndexRecord(job: Job<IndexRecordPayload, void, string>): Promise<void> {
    const { type, id } = job.data;
    if (!type || !id) {
      this.logger.warn('Index job missing type or id');
      return;
    }

    try {
      if (type === 'grade' || type === 'attendance' || type === 'student' || type === 'teacher' || type === 'class' || type === 'assessment' || type === 'school') {
        this.logger.debug(`Skipping operational index-record for ${type} ${id}`);
        return;
      }
    } catch (error: any) {
      this.logger.error(`Failed to index ${type} ${id}: ${error?.message}`);
      throw error;
    } finally {
      // Cooldown to prevent connection saturation
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  private async indexGrade(gradeId: string) {
    const grade = await this.prisma.grade.findUnique({
      where: { id: gradeId },
      include: {
        enrollment: {
          include: { student: true, class: true, school: true }
        }
      }
    });

    if (!grade || !grade.enrollment) return;

    const student = grade.enrollment.student;
    const className = grade.enrollment.class?.name || grade.enrollment.classLevel;
    const subject = grade.subject || 'Unknown Subject';

    const content = `Student: ${student.firstName} ${student.lastName}
Class: ${className}
Subject: ${subject}
Assessment: ${grade.assessmentName || 'Assessment'}
Type: ${grade.gradeType}
Grade: received ${grade.score} out of ${grade.maxScore}
Remarks: ${grade.remarks || 'None'}
Date: ${grade.signedAt.toLocaleDateString()}`.trim();

    await this.upsertChunk(
      grade.enrollment.schoolId,
      `grade_${grade.id}`,
      content,
      {
        type: 'grade',
        studentId: student.id,
        classId: grade.enrollment.classId,
        subject,
        timestamp: new Date().toISOString(),
        permissions: {
          roles: ['SUPER_ADMIN', 'SCHOOL_ADMIN', 'TEACHER'],
          allowedStudentId: student.id,
          allowedClassId: grade.enrollment.classId,
        }
      }
    );
  }

  private async indexAttendance(attendanceId: string) {
    const att = await this.prisma.attendance.findUnique({
      where: { id: attendanceId },
      include: {
        enrollment: {
          include: { student: true, class: true, school: true }
        }
      }
    });

    if (!att || !att.enrollment) return;
    const student = att.enrollment.student;
    const className = att.enrollment.class?.name || att.enrollment.classLevel;

    const content = `Student: ${student.firstName} ${student.lastName}
Class: ${className}
Attendance Date: ${att.date.toLocaleDateString()}
Status: ${att.status}
Remarks: ${att.remarks || 'None'}`.trim();

    await this.upsertChunk(
      att.enrollment.schoolId,
      `att_${att.id}`,
      content,
      {
        type: 'attendance',
        studentId: student.id,
        classId: att.enrollment.classId,
        timestamp: new Date().toISOString(),
        permissions: {
          roles: ['SUPER_ADMIN', 'SCHOOL_ADMIN', 'TEACHER'],
          allowedStudentId: student.id,
          allowedClassId: att.enrollment.classId,
        }
      }
    );
  }

  private async indexStudent(studentId: string) {
    const student = await this.prisma.student.findUnique({
      where: { id: studentId },
      include: {
        enrollments: { include: { school: true, class: true } }
      }
    });
    if (!student) return;

    for (const enr of student.enrollments) {
      const className = enr.class?.name || enr.classLevel;
      const content = `Student Profile: ${student.firstName} ${student.lastName}
Enrolled in: ${className}
School: ${enr.school.name}
Admitted: ${enr.createdAt.toLocaleDateString()}`.trim();

      await this.upsertChunk(
        enr.schoolId,
        `stu_${student.id}_${enr.id}`,
        content,
        {
          type: 'student_profile',
          studentId: student.id,
          classId: enr.classId,
          timestamp: new Date().toISOString(),
          permissions: {
            roles: ['SUPER_ADMIN', 'SCHOOL_ADMIN', 'TEACHER'],
            allowedStudentId: student.id,
            allowedClassId: enr.classId,
          }
        }
      );
    }
  }

  private async indexTeacher(teacherId: string) {
    const teacher = await this.prisma.teacher.findUnique({
      where: { id: teacherId },
      include: {
        school: true,
        classTeachers: {
          include: { class: true, classArm: true, subjectRef: true }
        }
      }
    });

    if (!teacher) return;

    const assignments = teacher.classTeachers.map(ct => {
      const className = ct.class?.name || ct.classArm?.name || 'N/A';
      return `- ${ct.subject || ct.subjectRef?.name || 'N/A'} for ${className}`;
    }).join('\n');

    const content = `
      Teacher: ${teacher.firstName} ${teacher.lastName}
      Email: ${teacher.email || 'N/A'}
      Phone: ${teacher.phone || 'N/A'}
      Staff ID: ${teacher.employeeId || teacher.teacherId}
      Specialization: ${teacher.subject || 'N/A'}
      Current Assignments:
      ${assignments || 'No active class assignments found.'}
    `.trim();

    await this.upsertChunk(
      teacher.schoolId,
      `teacher_profile_${teacher.id}`,
      content,
      {
        type: 'teacher_info',
        teacherId: teacher.id,
        timestamp: new Date().toISOString(),
        permissions: {
          roles: ['SUPER_ADMIN', 'SCHOOL_ADMIN', 'TEACHER'],
          isPublic: false,
          allowedTeacherId: teacher.id
        }
      }
    );
  }

  private async indexClass(classId: string) {
    const classData = await this.prisma.class.findUnique({
      where: { id: classId },
      include: {
        curricula: {
          include: {
            subjectRef: true,
            items: { orderBy: { weekNumber: 'asc' } }
          }
        },
        school: true
      }
    });

    if (!classData) return;

    const schemes = await this.prisma.schemeOfWork.findMany({
      where: {
        schoolId: classData.schoolId,
        status: { in: ['PUBLISHED', 'APPROVED'] },
      },
      include: {
        weeks: {
          orderBy: { weekNumber: 'asc' },
          include: { topics: true },
        },
      },
    });

    for (const scheme of schemes) {
      const subject = await this.prisma.subject.findUnique({
        where: { id: scheme.subjectId },
        select: { name: true },
      });
      const subjectName = subject?.name || 'Subject';
      const chunked = this.chunkArray(scheme.weeks, 5);
      for (const [index, weeks] of chunked.entries()) {
        const text = weeks
          .map(
            (w) =>
              `Week ${w.weekNumber}: ${w.topic}. Keys: ${w.topics.map((t) => t.stableKey).join(', ')}. Outcomes: ${w.learningOutcomes.join(', ')}`,
          )
          .join('\n');
        await this.upsertChunk(
          classData.schoolId,
          `class_sow_${classData.id}_${scheme.id}_${index}`,
          `School: ${classData.school.name}\nClass: ${classData.name}\nSubject: ${subjectName}\nScheme of Work (Part ${index + 1}):\n${text}`.trim(),
          {
            type: 'scheme_of_work',
            classId: classData.id,
            schemeId: scheme.id,
            subject: subjectName,
            timestamp: new Date().toISOString(),
            permissions: {
              roles: ['SUPER_ADMIN', 'SCHOOL_ADMIN', 'TEACHER', 'STUDENT'],
              isPublic: false,
              allowedClassId: classData.id,
            },
          },
        );
      }
    }

    for (const curriculum of classData.curricula) {
      const subjectName = curriculum.subjectRef?.name || curriculum.subject || 'N/A';
      const chunkedItems = this.chunkArray(curriculum.items, 5);
      
      for (const [index, items] of chunkedItems.entries()) {
        const curriculumText = items
          .map(i => `Week ${i.weekNumber}: ${i.topic}. Topics: ${i.subTopics.join(', ')}. Objectives: ${i.objectives.join(', ')}`)
          .join('\n');

        const content = `
          School: ${classData.school.name}
          Class: ${classData.name} (${classData.classLevel})
          Subject: ${subjectName}
          Curriculum Plan (Part ${index + 1}):
          ${curriculumText}
        `.trim();

        await this.upsertChunk(
          classData.schoolId,
          `class_curr_${classData.id}_${curriculum.id}_${index}`,
          content,
          { 
            type: 'curriculum', 
            classId: classData.id, 
            subject: subjectName,
            timestamp: new Date().toISOString(),
            permissions: {
              roles: ['SUPER_ADMIN', 'SCHOOL_ADMIN', 'TEACHER'],
              isPublic: false,
              allowedClassId: classData.id
            } 
          }
        );
      }
    }
  }

  private async indexAssessment(assessmentId: string) {
    const assessment = await this.prisma.assessment.findUnique({
      where: { id: assessmentId },
      include: {
        teacher: true,
        class: true,
        subject: true,
        questions: true
      }
    });

    if (!assessment) return;

    const questionsText = assessment.questions
      .map((q, i) => `${i + 1}. ${q.text} (${q.type})`)
      .join('\n');

    const content = `
      Teacher: ${assessment.teacher.firstName} ${assessment.teacher.lastName}
      Subject: ${assessment.subject.name}
      Assessment: ${assessment.title}
      Type: ${assessment.type}
      Grade Level: ${assessment.class?.classLevel || 'N/A'}
      Description: ${assessment.description || 'N/A'}
      Questions Summary:
      ${questionsText}
    `.trim();

    await this.upsertChunk(
      assessment.schoolId,
      `assessment_${assessment.id}`,
      content,
      {
        type: 'assessment',
        teacherId: assessment.teacherId,
        title: assessment.title,
        subject: assessment.subject.name,
        timestamp: assessment.updatedAt.toISOString(),
        permissions: {
          roles: ['SUPER_ADMIN', 'SCHOOL_ADMIN', 'TEACHER'],
          isPublic: false,
          allowedTeacherId: assessment.teacherId,
          allowedClassId: assessment.classId
        }
      }
    );
  }

  private async indexSchool(schoolId: string) {
    const [school, classCount, teacherCount, studentCount] = await Promise.all([
      this.prisma.school.findUnique({
        where: { id: schoolId },
        include: {
          academicSessions: {
            where: { status: 'ACTIVE' },
            include: { terms: { where: { status: 'ACTIVE' } } }
          }
        }
      }),
      this.prisma.class.count({ where: { schoolId } }),
      this.prisma.teacher.count({ where: { schoolId } }),
      this.prisma.enrollment.count({ where: { schoolId } })
    ]);

    if (!school) return;

    const session = school.academicSessions[0];
    const term = session?.terms[0];

    const content = `
      School Name: ${school.name}
      Location: ${school.address || 'N/A'}, ${school.city || 'N/A'}, ${school.state || 'N/A'}, ${school.country}
      Contact: ${school.email || 'N/A'}, ${school.phone || 'N/A'}
      Current Academic Session: ${session?.name || 'N/A'}
      Current Term: ${term?.name || 'N/A'}
      Educational Levels: ${[school.hasPrimary ? 'Primary' : '', school.hasSecondary ? 'Secondary' : '', school.hasTertiary ? 'Tertiary' : ''].filter(Boolean).join(', ')}
      
      SCHOOL ANALYTICS:
      - Total Classes: ${classCount}
      - Total Teachers: ${teacherCount}
      - Total Enrolled Students: ${studentCount}
    `.trim();

    await this.upsertChunk(
      schoolId,
      `school_profile_${schoolId}`,
      content,
      {
        type: 'school_info',
        timestamp: new Date().toISOString(),
        permissions: {
          roles: ['SUPER_ADMIN', 'SCHOOL_ADMIN', 'TEACHER', 'STUDENT'],
          isPublic: true
        }
      }
    );
  }

  private chunkArray<T>(array: T[], size: number): T[][] {
    return Array.from({ length: Math.ceil(array.length / size) }, (v, i) =>
      array.slice(i * size, i * size + size)
    );
  }

  private async upsertChunk(schoolId: string, externalId: string, content: string, metadata: any) {
    if (!this.aiService.isConfigured()) return;

    const existing = await this.prisma.knowledgeChunk.findFirst({
      where: {
        schoolId,
        metadata: { path: ['externalId'], equals: externalId },
      },
      select: { id: true }
    });

    const metadataWithId = { ...metadata, externalId };

    if (existing) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE "KnowledgeChunk" SET "content" = $1, "metadata" = $2::jsonb, "updatedAt" = NOW() WHERE "id" = $3`,
        content,
        JSON.stringify(metadataWithId),
        existing.id,
      );
      
      try {
        const embedding = await this.aiService.createEmbedding(content);
        const vectorString = `[${embedding.join(',')}]`;
        await this.prisma.$executeRawUnsafe(
          `UPDATE "KnowledgeChunk" SET "embedding" = $1::vector, "updatedAt" = NOW() WHERE "id" = $2`,
          vectorString,
          existing.id,
        );
      } catch (err: any) {
        this.logger.error(`Embedding failed for updated chunk ${existing.id}`);
      }
    } else {
      const id = `kc_${Math.random().toString(36).substring(2, 11)}`;
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO "KnowledgeChunk" ("id", "schoolId", "content", "metadata", "updatedAt")
         VALUES ($1, $2, $3, $4::jsonb, NOW())`,
        id,
        schoolId,
        content,
        JSON.stringify(metadataWithId),
      );
      try {
        const embedding = await this.aiService.createEmbedding(content);
        const vectorString = `[${embedding.join(',')}]`;
        await this.prisma.$executeRawUnsafe(
          `UPDATE "KnowledgeChunk" SET "embedding" = $1::vector, "updatedAt" = NOW() WHERE "id" = $2`,
          vectorString,
          id,
        );
      } catch (err: any) {
        this.logger.error(`Embedding failed for new chunk ${id}`);
      }
    }
  }
}
