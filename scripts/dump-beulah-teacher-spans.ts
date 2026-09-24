/** Read-only: multi-subject teachers, slot clashes, occupied-arm staff. */
import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });
const prisma = new PrismaClient();

async function main() {
  const school = await prisma.school.findFirst({
    where: { name: { contains: 'Beulah', mode: 'insensitive' } },
    select: { id: true },
  });
  if (!school) throw new Error('missing school');

  const periods = await prisma.timetablePeriod.findMany({
    where: { teacher: { schoolId: school.id }, term: { status: 'ACTIVE' }, type: 'LESSON' },
    select: {
      dayOfWeek: true,
      startTime: true,
      endTime: true,
      teacher: { select: { id: true, firstName: true, lastName: true, email: true, schoolType: true, user: { select: { email: true } } } },
      subject: { select: { name: true } },
      classArm: { select: { name: true, classLevel: { select: { code: true, type: true } } } },
    },
  });

  const byTeacher = new Map<string, { name: string; email: string; type: string | null; classes: Set<string>; subjects: Set<string>; slots: Map<string, string[]> }>();
  const bySlot = new Map<string, string[]>();

  for (const p of periods) {
    if (!p.teacher || !p.classArm) continue;
    const cls = `${p.classArm.classLevel.code} ${p.classArm.name}`;
    const key = p.teacher.id;
    const row = byTeacher.get(key) ?? {
      name: `${p.teacher.firstName} ${p.teacher.lastName}`,
      email: p.teacher.user?.email || p.teacher.email || '',
      type: p.teacher.schoolType,
      classes: new Set<string>(),
      subjects: new Set<string>(),
      slots: new Map<string, string[]>(),
    };
    row.classes.add(cls);
    if (p.subject?.name) row.subjects.add(p.subject.name);
    const slot = `${p.dayOfWeek} ${p.startTime}`;
    const existing = row.slots.get(slot) ?? [];
    existing.push(`${cls} ${p.subject?.name || ''}`);
    row.slots.set(slot, existing);
    byTeacher.set(key, row);

    const classSlot = `${cls}|${p.dayOfWeek}|${p.startTime}`;
    const teachers = bySlot.get(classSlot) ?? [];
    teachers.push(`${row.name} · ${p.subject?.name || 'no subject'}`);
    bySlot.set(classSlot, teachers);
  }

  const multiSubject = [...byTeacher.values()]
    .filter((t) => t.subjects.size > 1)
    .map((t) => ({
      name: t.name,
      email: t.email,
      type: t.type,
      subjects: [...t.subjects],
      classes: [...t.classes],
    }));

  const teacherClashes = [...byTeacher.values()].flatMap((t) =>
    [...t.slots.entries()]
      .filter(([, items]) => items.length > 1)
      .map(([slot, items]) => ({ teacher: t.name, email: t.email, slot, items })),
  );

  const classClashes = [...bySlot.entries()]
    .filter(([, teachers]) => new Set(teachers).size > 1)
    .slice(0, 25)
    .map(([slot, teachers]) => ({ slot, teachers }));

  const occupied = ['JSS1 A', 'JSS2 A', 'JSS3 A', 'SS1 A', 'SS2 A', 'SS3 A', 'PRIMARY1 A'];
  const onOccupied = [...byTeacher.values()]
    .filter((t) => t.type === 'SECONDARY' && [...t.classes].some((c) => occupied.includes(c)))
    .map((t) => ({
      name: t.name,
      email: t.email,
      subjects: [...t.subjects],
      classes: [...t.classes].filter((c) => c.startsWith('JSS') || c.startsWith('SS')),
    }))
    .sort((a, b) => b.classes.length - a.classes.length);

  const formFlags = await prisma.classTeacher.groupBy({
    by: ['isFormTeacher', 'isPrimary'],
    where: { teacher: { schoolId: school.id } },
    _count: { _all: true },
  });

  console.log(
    JSON.stringify(
      {
        activeLessonCount: periods.length,
        multiSubjectCount: multiSubject.length,
        multiSubject: multiSubject.slice(0, 12),
        teacherClashCount: teacherClashes.length,
        teacherClashes: teacherClashes.slice(0, 15),
        classClashCount: [...bySlot.values()].filter((t) => new Set(t).size > 1).length,
        classClashes: classClashes.slice(0, 12),
        secondaryOnOccupiedArms: onOccupied.slice(0, 15),
        formFlags,
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
