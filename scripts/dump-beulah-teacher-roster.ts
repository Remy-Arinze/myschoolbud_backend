/**
 * Read-only roster dump for Beulah teacher-dashboard QA.
 * Prints teachers, form assignments, class headcount, and timetable span.
 * Run from backend: npx tsx scripts/dump-beulah-teacher-roster.ts
 */
import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const prisma = new PrismaClient();

async function main() {
  const school = await prisma.school.findFirst({
    where: { name: { contains: 'Beulah', mode: 'insensitive' } },
    select: { id: true, name: true, hasPrimary: true, hasSecondary: true, hasTertiary: true },
  });
  if (!school) throw new Error('Beulah school not found');

  const terms = await prisma.term.findMany({
    where: { academicSession: { schoolId: school.id } },
    select: {
      id: true,
      name: true,
      status: true,
      academicSession: { select: { name: true, status: true, schoolType: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 6,
  });

  const arms = await prisma.classArm.findMany({
    where: { classLevel: { schoolId: school.id }, isActive: true },
    select: {
      id: true,
      name: true,
      classTeacherId: true,
      classLevel: { select: { name: true, code: true, type: true } },
      _count: { select: { enrollments: true } },
    },
    orderBy: [{ classLevel: { type: 'asc' } }, { classLevel: { level: 'asc' } }, { name: 'asc' }],
  });

  const activeEnrollments = await prisma.enrollment.groupBy({
    by: ['classArmId'],
    where: { schoolId: school.id, isActive: true, classArmId: { not: null } },
    _count: { _all: true },
  });
  const activeByArm = new Map(activeEnrollments.map((e) => [e.classArmId, e._count._all]));

  const assignments = await prisma.classTeacher.findMany({
    where: { teacher: { schoolId: school.id } },
    select: {
      isFormTeacher: true,
      isPrimary: true,
      subject: true,
      subjectRef: { select: { name: true, code: true } },
      classArm: {
        select: {
          id: true,
          name: true,
          classLevel: { select: { name: true, code: true, type: true } },
        },
      },
      teacher: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          schoolType: true,
          user: { select: { email: true } },
        },
      },
    },
  });

  const periods = await prisma.timetablePeriod.findMany({
    where: { teacher: { schoolId: school.id }, type: 'LESSON' },
    select: {
      teacherId: true,
      dayOfWeek: true,
      subject: { select: { name: true } },
      classArm: {
        select: { name: true, classLevel: { select: { code: true, type: true } } },
      },
      term: { select: { status: true, name: true } },
    },
  });

  type Span = {
    classes: Set<string>;
    subjects: Set<string>;
    days: Set<string>;
    activeTermLessons: number;
    allLessons: number;
  };
  const spans = new Map<string, Span>();
  for (const p of periods) {
    if (!p.teacherId) continue;
    const span = spans.get(p.teacherId) ?? {
      classes: new Set<string>(),
      subjects: new Set<string>(),
      days: new Set<string>(),
      activeTermLessons: 0,
      allLessons: 0,
    };
    const cls = p.classArm
      ? `${p.classArm.classLevel.code || p.classArm.classLevel.type} ${p.classArm.name}`.trim()
      : 'unassigned';
    span.classes.add(cls);
    if (p.subject?.name) span.subjects.add(p.subject.name);
    span.days.add(p.dayOfWeek);
    span.allLessons += 1;
    if (p.term.status === 'ACTIVE') span.activeTermLessons += 1;
    spans.set(p.teacherId, span);
  }

  const teacherMap = new Map<
    string,
    {
      id: string;
      name: string;
      email: string;
      schoolType: string | null;
      formArms: string[];
      subjectArms: string[];
      subjects: string[];
    }
  >();

  for (const a of assignments) {
    const t = a.teacher;
    const row = teacherMap.get(t.id) ?? {
      id: t.id,
      name: `${t.firstName} ${t.lastName}`,
      email: t.user?.email || t.email || '',
      schoolType: t.schoolType,
      formArms: [],
      subjectArms: [],
      subjects: [],
    };
    const arm = a.classArm
      ? `${a.classArm.classLevel.code || a.classArm.classLevel.name} ${a.classArm.name} (${a.classArm.classLevel.type})`
      : 'no-arm';
    if (a.isFormTeacher || a.isPrimary) row.formArms.push(arm);
    else row.subjectArms.push(`${arm} · ${a.subjectRef?.name || a.subject || 'subject'}`);
    const sub = a.subjectRef?.name || a.subject;
    if (sub && !row.subjects.includes(sub)) row.subjects.push(sub);
    teacherMap.set(t.id, row);
  }

  const teachers = [...teacherMap.values()].map((t) => {
    const span = spans.get(t.id);
    return {
      ...t,
      timetableClasses: span ? [...span.classes].sort() : [],
      timetableSubjects: span ? [...span.subjects].sort() : [],
      timetableDays: span ? [...span.days] : [],
      activeTermLessons: span?.activeTermLessons ?? 0,
      allLessons: span?.allLessons ?? 0,
    };
  });

  const interesting = teachers
    .filter((t) => t.schoolType === 'SECONDARY')
    .sort((a, b) => b.timetableClasses.length - a.timetableClasses.length || b.timetableSubjects.length - a.timetableSubjects.length);

  const formSecondary = interesting.filter((t) => t.formArms.length > 0);
  const multiNoForm = interesting.filter((t) => t.formArms.length === 0 && t.timetableClasses.length > 1);
  const primary = teachers.filter((t) => t.schoolType === 'PRIMARY');

  console.log(
    JSON.stringify(
      {
        school,
        terms,
        armCount: arms.length,
        arms: arms.map((a) => ({
          type: a.classLevel.type,
          level: a.classLevel.code || a.classLevel.name,
          arm: a.name,
          enrollments: a._count.enrollments,
          activeStudents: activeByArm.get(a.id) ?? 0,
          hasClassTeacher: Boolean(a.classTeacherId),
        })),
        teacherCount: teachers.length,
        primaryForm: primary.map((t) => ({
          name: t.name,
          email: t.email,
          formArms: t.formArms,
          activeTermLessons: t.activeTermLessons,
          timetableSubjects: t.timetableSubjects,
        })),
        secondaryFormSample: formSecondary.slice(0, 8).map((t) => ({
          name: t.name,
          email: t.email,
          formArms: t.formArms,
          subjectCount: t.subjects.length,
          subjects: t.subjects,
          timetableClassCount: t.timetableClasses.length,
          timetableClasses: t.timetableClasses,
          timetableSubjects: t.timetableSubjects,
          activeTermLessons: t.activeTermLessons,
        })),
        secondaryMultiClassNoForm: multiNoForm.slice(0, 8).map((t) => ({
          name: t.name,
          email: t.email,
          subjectCount: t.subjects.length,
          subjects: t.subjects,
          timetableClassCount: t.timetableClasses.length,
          timetableClasses: t.timetableClasses,
          timetableSubjects: t.timetableSubjects,
          activeTermLessons: t.activeTermLessons,
        })),
        counts: {
          primaryTeachers: primary.length,
          secondaryTeachers: interesting.length,
          secondaryFormTeachers: formSecondary.length,
          secondaryMultiClassNonForm: multiNoForm.length,
          teachersWithActiveLessons: teachers.filter((t) => t.activeTermLessons > 0).length,
        },
      },
      null,
      2,
    ),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
