import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { UserWithContext } from '../../../auth/types/user-with-context.type';
import { SchoolSettingsService } from '../../../school-settings/school-settings.service';

/**
 * Service for teacher operations scoped to their current/active school
 * All operations here are filtered by the teacher's school
 */
@Injectable()
export class TeacherCurrentSchoolService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly schoolSettingsService: SchoolSettingsService,
  ) { }

  /**
   * Get current teacher profile
   */
  async getMyProfile(user: UserWithContext) {
    const schoolId = user.currentSchoolId;
    const teacherIdFromJwt = user.currentProfileId; // This is the teacherId field (unique ID), not the database id

    if (!schoolId || !teacherIdFromJwt) {
      throw new BadRequestException('Teacher profile not found in current context');
    }

    // Find teacher — try database id first (CUID, as stored by current auth),
    // then fall back to teacherId field (formatted string like AG-TCH-xxx) for backward compat
    let teacher = await this.prisma.teacher.findUnique({
      where: { id: teacherIdFromJwt },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            phone: true,
            accountStatus: true,
          },
        },
        school: {
          select: {
            id: true,
            name: true,
            hasPrimary: true,
            hasSecondary: true,
            hasTertiary: true,
          },
        },
      },
    });

    // Fallback: the profileId in the JWT might be the teacherId string (e.g. AG-TCH-xxx)
    if (!teacher) {
      teacher = await this.prisma.teacher.findUnique({
        where: { teacherId: teacherIdFromJwt },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              phone: true,
              accountStatus: true,
            },
          },
          school: {
            select: {
              id: true,
              name: true,
              hasPrimary: true,
              hasSecondary: true,
              hasTertiary: true,
            },
          },
        },
      });
    }

    if (!teacher) {
      throw new NotFoundException('Teacher profile not found');
    }


    if (teacher.schoolId !== schoolId) {
      throw new BadRequestException('Teacher does not belong to current school');
    }

    return {
      id: teacher.id,
      teacherId: teacher.teacherId,
      publicId: teacher.publicId,
      firstName: teacher.firstName,
      lastName: teacher.lastName,
      email: teacher.email,
      phone: teacher.phone,
      subject: teacher.subject,
      schoolType: teacher.schoolType,
      isTemporary: teacher.isTemporary,
      employeeId: teacher.employeeId,
      createdAt: teacher.createdAt,
      user: teacher.user,
      school: teacher.school,
    };
  }

  /**
   * Get teacher's current school
   */
  async getMySchool(user: UserWithContext) {
    const schoolId = user.currentSchoolId;

    if (!schoolId) {
      throw new BadRequestException('Teacher is not associated with any school');
    }

    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
      select: {
        id: true,
        name: true,
        logo: true,
        hasPrimary: true,
        hasSecondary: true,
        hasTertiary: true,
        schoolId: true,
        slug: true,
        customDomain: true,
        customDomainStatus: true,
        branding: true,
      },
    });

    if (!school) {
      throw new NotFoundException('School not found');
    }

    const runtimePolicies = await this.schoolSettingsService.getRuntimePolicies(school.id);
    return { ...school, runtimePolicies };
  }

  /**
   * Get subjects that a teacher is authorized to grade for a specific class
   *
   * Logic:
   * - PRIMARY: If teacher is the class teacher (isPrimary=true), they can grade ALL subjects
   * - SECONDARY: Teacher can only grade subjects they're assigned to via ClassTeacher or Timetable
   * - TERTIARY: Teacher can only grade courses they're assigned to
   */
  async getSubjectsForClass(user: UserWithContext, classId: string) {
    const schoolId = user.currentSchoolId;
    const teacherIdFromJwt = user.currentProfileId;

    if (!schoolId || !teacherIdFromJwt) {
      throw new BadRequestException('Teacher profile not found in current context');
    }

    // Get teacher — try database id first, then teacherId string for backward compat
    let teacher = await this.prisma.teacher.findUnique({
      where: { id: teacherIdFromJwt },
    });
    if (!teacher) {
      teacher = await this.prisma.teacher.findUnique({
        where: { teacherId: teacherIdFromJwt },
      });
    }

    if (!teacher || teacher.schoolId !== schoolId) {
      throw new NotFoundException('Teacher not found in this school');
    }


    // Determine if classId is a ClassArm or Class
    const classArm = await this.prisma.classArm.findUnique({
      where: { id: classId },
      include: {
        classLevel: true,
      },
    });

    let classEntity: any = null;
    let schoolType: 'PRIMARY' | 'SECONDARY' | 'TERTIARY' = 'SECONDARY';
    let classLevelId: string | null = null;

    if (classArm) {
      // It's a ClassArm (PRIMARY/SECONDARY)
      schoolType = (classArm.classLevel?.type as 'PRIMARY' | 'SECONDARY') || 'SECONDARY';
      classLevelId = classArm.classLevelId;
    } else {
      // Check if it's a Class (TERTIARY)
      classEntity = await this.prisma.class.findUnique({
        where: { id: classId },
      });

      if (!classEntity) {
        throw new NotFoundException('Class not found');
      }

      schoolType = (classEntity.type as 'PRIMARY' | 'SECONDARY' | 'TERTIARY') || 'TERTIARY';
    }

    // Check if teacher is the primary/class teacher for this class
    const classTeacherAssignment = await this.prisma.classTeacher.findFirst({
      where: {
        teacherId: teacher.id,
        ...(classArm ? { classArmId: classArm.id } : { classId: classEntity?.id }),
      },
      include: {
        subjectRef: true,
      },
    });

    // Secondary form teachers are class charge, not graders of every subject.
    const isPrimaryTeacher =
      schoolType === 'PRIMARY' && (classTeacherAssignment?.isPrimary || false);

    // For PRIMARY school class teachers - they can grade ALL subjects for that class level
    if (schoolType === 'PRIMARY' && isPrimaryTeacher && classLevelId) {
      const allSubjects = await this.prisma.subject.findMany({
        where: {
          schoolId,
          isActive: true,
          OR: [
            { schoolType: 'PRIMARY' },
            { schoolType: null }, // Subjects that apply to all types
          ],
        },
        orderBy: { name: 'asc' },
      });

      return {
        subjects: allSubjects.map((s) => ({
          id: s.id,
          name: s.name,
          code: s.code,
          source: 'PRIMARY_CLASS_TEACHER' as const,
        })),
        schoolType,
        isPrimaryTeacher: true,
        canGradeAllSubjects: true,
      };
    }

    // For SECONDARY/TERTIARY or non-primary teachers - collect subjects from multiple sources
    const subjectMap = new Map<
      string,
      { id: string; name: string; code: string | null; source: string }
    >();

    // Source 1: ClassTeacher assignments with subjectId
    const classTeacherAssignments = await this.prisma.classTeacher.findMany({
      where: {
        teacherId: teacher.id,
        ...(classArm ? { classArmId: classArm.id } : { classId: classEntity?.id }),
        subjectId: { not: null },
      },
      include: {
        subjectRef: true,
      },
    });

    for (const ct of classTeacherAssignments) {
      if (ct.subjectRef && !subjectMap.has(ct.subjectRef.id)) {
        subjectMap.set(ct.subjectRef.id, {
          id: ct.subjectRef.id,
          name: ct.subjectRef.name,
          code: ct.subjectRef.code,
          source: 'CLASS_TEACHER_ASSIGNMENT',
        });
      }
    }

    // Source 2: ClassTeacher assignments with subject string (legacy)
    const legacyAssignments = await this.prisma.classTeacher.findMany({
      where: {
        teacherId: teacher.id,
        ...(classArm ? { classArmId: classArm.id } : { classId: classEntity?.id }),
        subject: { not: null },
        subjectId: null, // Only legacy assignments without proper subjectId
      },
    });

    for (const ct of legacyAssignments) {
      if (ct.subject) {
        // Try to find matching Subject entity
        const matchingSubject = await this.prisma.subject.findFirst({
          where: {
            schoolId,
            name: { equals: ct.subject, mode: 'insensitive' },
            isActive: true,
          },
        });

        if (matchingSubject && !subjectMap.has(matchingSubject.id)) {
          subjectMap.set(matchingSubject.id, {
            id: matchingSubject.id,
            name: matchingSubject.name,
            code: matchingSubject.code,
            source: 'LEGACY_CLASS_TEACHER',
          });
        }
      }
    }

    // Source 3: TimetablePeriod assignments (active term)
    const activeTerm = await this.prisma.term.findFirst({
      where: {
        status: 'ACTIVE',
        academicSession: {
          schoolId,
          status: 'ACTIVE',
          ...(schoolType !== 'TERTIARY' ? { schoolType } : {}),
        },
      },
    });

    if (activeTerm) {
      const timetablePeriods = await this.prisma.timetablePeriod.findMany({
        where: {
          teacherId: teacher.id,
          termId: activeTerm.id,
          ...(classArm ? { classArmId: classArm.id } : { classId: classEntity?.id }),
          subjectId: { not: null },
        },
        include: {
          subject: true,
        },
      });

      for (const period of timetablePeriods) {
        if (period.subject && !subjectMap.has(period.subject.id)) {
          subjectMap.set(period.subject.id, {
            id: period.subject.id,
            name: period.subject.name,
            code: period.subject.code,
            source: 'TIMETABLE',
          });
        }
      }
    }

    // Source 4: For TERTIARY - check course assignments
    if (schoolType === 'TERTIARY' && classEntity) {
      const courseAssignments = await this.prisma.timetablePeriod.findMany({
        where: {
          teacherId: teacher.id,
          courseId: classEntity.id,
        },
        include: {
          course: true,
        },
      });

      for (const period of courseAssignments) {
        if (period.course && !subjectMap.has(period.course.id)) {
          subjectMap.set(period.course.id, {
            id: period.course.id,
            name: period.course.name,
            code: period.course.code,
            source: 'COURSE_ASSIGNMENT',
          });
        }
      }
    }

    return {
      subjects: Array.from(subjectMap.values()).sort((a, b) => a.name.localeCompare(b.name)),
      schoolType,
      isPrimaryTeacher,
      canGradeAllSubjects: false,
    };
  }
}
