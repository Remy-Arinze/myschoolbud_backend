/**
 * Seed Beulah High School with PRIMARY + SECONDARY classes, students, and teachers.
 *
 * - 2 students per class (Primary 1–6, JSS 1–3, SS 1–3)
 * - 1 class teacher per primary class
 * - 3–4 teachers per secondary subject
 *
 * Run from backend: npx tsx scripts/seed-beulah-high-school.ts
 */
import * as path from 'path';
import * as bcrypt from 'bcryptjs';
import { PrismaClient, SessionStatus, TermStatus } from '@prisma/client';
import * as dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const prisma = new PrismaClient();

const SCHOOL_NAME = 'Beulah High School';
const SCHOOL_EMAIL = 'beulah.high@agora.test';
const ADMIN_EMAIL = 'beulah.admin@agora.test';
const ADMIN_PHONE = '+2347018800001';
const SCHOOL_PHONE = '+2347018800000';
const PASSWORD = 'Test1234!';
const ACADEMIC_YEAR = '2026/2027';
const EMAIL_ALIAS_BASE = 'remyarinze';

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function shortId(length = 6): string {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += CHARS.charAt(Math.floor(Math.random() * CHARS.length));
  }
  return result;
}

function schoolInitials(name: string): string {
  const cleaned = name
    .toUpperCase()
    .replace(/\b(SCHOOL|ACADEMY|COLLEGE|UNIVERSITY|INSTITUTE|SECONDARY|PRIMARY|HIGH)\b/gi, '')
    .replace(/[^A-Z0-9]/g, '')
    .substring(0, 2);
  if (cleaned.length < 2) {
    return name
      .toUpperCase()
      .replace(/[^A-Z]/g, '')
      .substring(0, 2)
      .padEnd(2, 'X');
  }
  return cleaned;
}

type LevelDef = {
  name: string;
  code: string;
  level: number;
  type: 'PRIMARY' | 'SECONDARY';
};

const LEVELS: LevelDef[] = [
  { name: 'Primary 1', code: 'PRIMARY1', level: 1, type: 'PRIMARY' },
  { name: 'Primary 2', code: 'PRIMARY2', level: 2, type: 'PRIMARY' },
  { name: 'Primary 3', code: 'PRIMARY3', level: 3, type: 'PRIMARY' },
  { name: 'Primary 4', code: 'PRIMARY4', level: 4, type: 'PRIMARY' },
  { name: 'Primary 5', code: 'PRIMARY5', level: 5, type: 'PRIMARY' },
  { name: 'Primary 6', code: 'PRIMARY6', level: 6, type: 'PRIMARY' },
  { name: 'JSS 1', code: 'JSS1', level: 1, type: 'SECONDARY' },
  { name: 'JSS 2', code: 'JSS2', level: 2, type: 'SECONDARY' },
  { name: 'JSS 3', code: 'JSS3', level: 3, type: 'SECONDARY' },
  { name: 'SS 1', code: 'SS1', level: 4, type: 'SECONDARY' },
  { name: 'SS 2', code: 'SS2', level: 5, type: 'SECONDARY' },
  { name: 'SS 3', code: 'SS3', level: 6, type: 'SECONDARY' },
];

type StudentSeed = {
  classCode: string;
  firstName: string;
  lastName: string;
  gender: 'Female' | 'Male';
  state: string;
  parentName: string;
  parentRelationship: string;
};

const STUDENTS: StudentSeed[] = [
  { classCode: 'PRIMARY1', firstName: 'Chiamaka', lastName: 'Okafor', gender: 'Female', state: 'Anambra', parentName: 'Ifeanyi Okafor', parentRelationship: 'Father' },
  { classCode: 'PRIMARY1', firstName: 'Ibrahim', lastName: 'Musa', gender: 'Male', state: 'Kano', parentName: 'Amina Musa', parentRelationship: 'Mother' },
  { classCode: 'PRIMARY2', firstName: 'Aisha', lastName: 'Bello', gender: 'Female', state: 'Kaduna', parentName: 'Usman Bello', parentRelationship: 'Father' },
  { classCode: 'PRIMARY2', firstName: 'Tunde', lastName: 'Adeyemi', gender: 'Male', state: 'Oyo', parentName: 'Funmilayo Adeyemi', parentRelationship: 'Mother' },
  { classCode: 'PRIMARY3', firstName: 'Ngozi', lastName: 'Eze', gender: 'Female', state: 'Enugu', parentName: 'Chukwudi Eze', parentRelationship: 'Father' },
  { classCode: 'PRIMARY3', firstName: 'Chinedu', lastName: 'Nwosu', gender: 'Male', state: 'Imo', parentName: 'Adaeze Nwosu', parentRelationship: 'Mother' },
  { classCode: 'PRIMARY4', firstName: 'Fatima', lastName: 'Abdullahi', gender: 'Female', state: 'Kano', parentName: 'Hassan Abdullahi', parentRelationship: 'Father' },
  { classCode: 'PRIMARY4', firstName: 'Oluwaseun', lastName: 'Adebayo', gender: 'Male', state: 'Osun', parentName: 'Bukola Adebayo', parentRelationship: 'Mother' },
  { classCode: 'PRIMARY5', firstName: 'Blessing', lastName: 'Okoro', gender: 'Female', state: 'Rivers', parentName: 'Emmanuel Okoro', parentRelationship: 'Father' },
  { classCode: 'PRIMARY5', firstName: 'Yusuf', lastName: 'Mohammed', gender: 'Male', state: 'Kaduna', parentName: 'Hauwa Mohammed', parentRelationship: 'Mother' },
  { classCode: 'PRIMARY6', firstName: 'Yetunde', lastName: 'Balogun', gender: 'Female', state: 'Lagos', parentName: 'Kehinde Balogun', parentRelationship: 'Father' },
  { classCode: 'PRIMARY6', firstName: 'Emeka', lastName: 'Obi', gender: 'Male', state: 'Anambra', parentName: 'Nneka Obi', parentRelationship: 'Mother' },
  { classCode: 'JSS1', firstName: 'Chioma', lastName: 'Nnamani', gender: 'Female', state: 'Enugu', parentName: 'Obinna Nnamani', parentRelationship: 'Father' },
  { classCode: 'JSS1', firstName: 'Kelechi', lastName: 'Okonkwo', gender: 'Male', state: 'Anambra', parentName: 'Ijeoma Okonkwo', parentRelationship: 'Mother' },
  { classCode: 'JSS2', firstName: 'Zainab', lastName: 'Lawal', gender: 'Female', state: 'Kwara', parentName: 'Abubakar Lawal', parentRelationship: 'Father' },
  { classCode: 'JSS2', firstName: 'Adeola', lastName: 'Afolabi', gender: 'Male', state: 'Ogun', parentName: 'Titilayo Afolabi', parentRelationship: 'Mother' },
  { classCode: 'JSS3', firstName: 'Ifeoma', lastName: 'Chukwu', gender: 'Female', state: 'Abia', parentName: 'Chidi Chukwu', parentRelationship: 'Father' },
  { classCode: 'JSS3', firstName: 'Sani', lastName: 'Danjuma', gender: 'Male', state: 'Kaduna', parentName: 'Hadiza Danjuma', parentRelationship: 'Mother' },
  { classCode: 'SS1', firstName: 'Funke', lastName: 'Adeyemi', gender: 'Female', state: 'Oyo', parentName: 'Olumide Adeyemi', parentRelationship: 'Father' },
  { classCode: 'SS1', firstName: 'Chukwuemeka', lastName: 'Okafor', gender: 'Male', state: 'Anambra', parentName: 'Amaka Okafor', parentRelationship: 'Mother' },
  { classCode: 'SS2', firstName: 'Amaka', lastName: 'Nwosu', gender: 'Female', state: 'Imo', parentName: 'Ikenna Nwosu', parentRelationship: 'Father' },
  { classCode: 'SS2', firstName: 'Babatunde', lastName: 'Balogun', gender: 'Male', state: 'Lagos', parentName: 'Adebisi Balogun', parentRelationship: 'Mother' },
  { classCode: 'SS3', firstName: 'Halima', lastName: 'Bello', gender: 'Female', state: 'Kano', parentName: 'Musa Bello', parentRelationship: 'Father' },
  { classCode: 'SS3', firstName: 'Ikenna', lastName: 'Eze', gender: 'Male', state: 'Enugu', parentName: 'Ngozi Eze', parentRelationship: 'Mother' },
];

const PRIMARY_CLASS_TEACHERS: Array<{ classCode: string; firstName: string; lastName: string }> = [
  { classCode: 'PRIMARY1', firstName: 'Adaeze', lastName: 'Okeke' },
  { classCode: 'PRIMARY2', firstName: 'Femi', lastName: 'Adebayo' },
  { classCode: 'PRIMARY3', firstName: 'Halima', lastName: 'Suleiman' },
  { classCode: 'PRIMARY4', firstName: 'Chukwuma', lastName: 'Nwachukwu' },
  { classCode: 'PRIMARY5', firstName: 'Kemi', lastName: 'Ogundipe' },
  { classCode: 'PRIMARY6', firstName: 'Musa', lastName: 'Ibrahim' },
];

const SECONDARY_SUBJECTS: Array<{ name: string; code: string }> = [
  { name: 'English Language', code: 'ENG' },
  { name: 'Mathematics', code: 'MATH' },
  { name: 'Physics', code: 'PHY' },
  { name: 'Chemistry', code: 'CHEM' },
  { name: 'Biology', code: 'BIO' },
  { name: 'Further Mathematics', code: 'FMATH' },
  { name: 'Economics', code: 'ECON' },
  { name: 'Government', code: 'GOVT' },
  { name: 'Literature in English', code: 'LIT' },
  { name: 'Geography', code: 'GEO' },
  { name: 'Agricultural Science', code: 'AGSC' },
  { name: 'Computer Science', code: 'COMP' },
  { name: 'Civic Education', code: 'CVCE' },
  { name: 'History', code: 'HIST' },
  { name: 'Fine Arts', code: 'FART' },
  { name: 'Technical Drawing', code: 'TDRW' },
  { name: 'Food & Nutrition', code: 'FNU' },
  { name: 'Christian Religious Studies', code: 'CRS' },
  { name: 'Islamic Religious Studies', code: 'IRS' },
  { name: 'French', code: 'FREN' },
  { name: 'Yoruba', code: 'YORB' },
  { name: 'Commerce', code: 'COMM' },
  { name: 'Accounting', code: 'ACCT' },
];

const SECONDARY_CORE_CODES = new Set(['ENG', 'MATH', 'PHY', 'CHEM', 'BIO', 'ECON', 'CVCE']);

const TEACHER_FIRST_NAMES = [
  'Abubakar', 'Adaobi', 'Bola', 'Chinyere', 'Damilola', 'Emeka', 'Folake', 'Gbenga',
  'Hassan', 'Ijeoma', 'Jide', 'Kunle', 'Lanre', 'Nneka', 'Olumide', 'Patience',
  'Rotimi', 'Segun', 'Titilayo', 'Uche', 'Wale', 'Yewande', 'Zainab', 'Ikechukwu',
  'Nnamdi', 'Omolara', 'Tochukwu', 'Rashida', 'Comfort', 'Idris',
];

const TEACHER_LAST_NAMES = [
  'Adebayo', 'Adeleke', 'Akinola', 'Alabi', 'Bakare', 'Chukwu', 'Dike', 'Eze',
  'Ibrahim', 'Idowu', 'Iheanacho', 'Lawal', 'Madu', 'Nwachukwu', 'Obi', 'Ogundipe',
  'Okafor', 'Okeke', 'Okoro', 'Olatunji', 'Onuoha', 'Osakwe', 'Suleiman', 'Udo',
  'Yakubu', 'Yusuf', 'Balogun', 'Nwosu', 'Mohammed', 'Afolabi',
];

function teacherCountForSubject(code: string): number {
  return SECONDARY_CORE_CODES.has(code) ? 4 : 3;
}

function secondaryTeacherName(index: number): { firstName: string; lastName: string } {
  return {
    firstName: TEACHER_FIRST_NAMES[index % TEACHER_FIRST_NAMES.length],
    lastName: TEACHER_LAST_NAMES[Math.floor(index / TEACHER_FIRST_NAMES.length) % TEACHER_LAST_NAMES.length],
  };
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function teacherEmail(slug: string): string {
  return `${EMAIL_ALIAS_BASE}+beulah-teacher-${slug.toLowerCase()}@gmail.com`;
}

function studentDob(classCode: string): Date {
  const match = classCode.match(/(\d+)$/);
  const n = match ? parseInt(match[1], 10) : 1;
  const year = classCode.startsWith('PRIMARY') ? 2020 - (n - 1) : classCode.startsWith('JSS') ? 2014 - (n - 1) : 2011 - (n - 1);
  return new Date(`${year}-03-15T00:00:00.000Z`);
}

function studentEmail(s: StudentSeed): string {
  const slug = `${slugify(s.firstName)}-${slugify(s.lastName)}-${s.classCode.toLowerCase()}`;
  return `${EMAIL_ALIAS_BASE}+beulah-student-${slug}@gmail.com`;
}

async function uniquePublicId(schoolName: string): Promise<string> {
  const initials = schoolInitials(schoolName);
  for (let i = 0; i < 30; i++) {
    const publicId = `AG-${initials}-${shortId(6)}`;
    const [admin, teacher, student] = await Promise.all([
      prisma.schoolAdmin.findFirst({ where: { publicId } }),
      prisma.teacher.findFirst({ where: { publicId } }),
      prisma.student.findFirst({ where: { publicId } }),
    ]);
    if (!admin && !teacher && !student) return publicId;
  }
  throw new Error('Unable to generate unique public ID');
}

async function uniqueStudentUid(schoolName: string): Promise<string> {
  const initials = schoolInitials(schoolName);
  const yy = String(new Date().getFullYear()).slice(-2);
  for (let i = 0; i < 50; i++) {
    const uid = `AG-${initials}-${yy}-${shortId(6)}`;
    const existing = await prisma.student.findFirst({ where: { uid } });
    if (!existing) return uid;
  }
  return `AG-ST-${uuidv4().replace(/-/g, '').toUpperCase()}`;
}

async function ensureSchool() {
  let school = await prisma.school.findFirst({
    where: { OR: [{ name: SCHOOL_NAME }, { email: SCHOOL_EMAIL }] },
  });

  if (!school) {
    school = await prisma.school.create({
      data: {
        name: SCHOOL_NAME,
        schoolId: `AG-SCH-${uuidv4().replace(/-/g, '').toUpperCase()}`,
        address: '14 Beulah Avenue, Ikeja',
        city: 'Lagos',
        state: 'Lagos',
        country: 'Nigeria',
        phone: SCHOOL_PHONE,
        email: SCHOOL_EMAIL,
        isActive: true,
        hasPrimary: true,
        hasSecondary: true,
        hasTertiary: false,
        registrationStatus: 'VERIFIED',
        verifiedAt: new Date(),
      },
    });
    console.log(`Created school ${school.name} (${school.id})`);
  } else {
    school = await prisma.school.update({
      where: { id: school.id },
      data: {
        name: SCHOOL_NAME,
        isActive: true,
        hasPrimary: true,
        hasSecondary: true,
        hasTertiary: false,
        registrationStatus: 'VERIFIED',
        verifiedAt: school.verifiedAt || new Date(),
      },
    });
    console.log(`Reusing school ${school.name} (${school.id})`);
  }

  const freePlan = await prisma.subscriptionPlan.findFirst({ where: { tierCode: 'FREE' } });
  const existingSub = await prisma.subscription.findUnique({ where: { schoolId: school.id } });
  if (!existingSub) {
    await prisma.subscription.create({
      data: {
        schoolId: school.id,
        tier: 'FREE',
        planId: freePlan?.id,
        isActive: true,
        maxStudents: -1,
        maxTeachers: -1,
        maxAdmins: freePlan?.maxAdmins ?? 2,
        aiCredits: freePlan?.aiCredits ?? 0,
      },
    });
    console.log('Created subscription with unlimited teachers/students');
  } else if (existingSub.maxTeachers !== -1 || existingSub.maxStudents !== -1) {
    await prisma.subscription.update({
      where: { schoolId: school.id },
      data: { maxTeachers: -1, maxStudents: -1, isActive: true },
    });
    console.log('Updated subscription to unlimited teachers/students');
  }

  await prisma.schoolStructureConfig.upsert({
    where: { schoolId: school.id },
    create: {
      schoolId: school.id,
      defaultClassArmNames: ['A'],
      classLevelNamingMode: 'STANDARD',
      subjectRegistryMode: 'AGORA_PLUS_CUSTOM',
      defaultAgoraSubjectIds: [],
      facultyStructureVisible: true,
      teacherScope: 'ASSIGNED_ONLY',
      customRoles: [],
      admissionApproverRoles: [],
      transferApproverRoles: [],
    },
    update: {
      defaultClassArmNames: ['A'],
    },
  });

  return school;
}

async function ensureAdmin(schoolId: string) {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  let user = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash,
        role: 'SCHOOL_ADMIN',
        accountStatus: 'ACTIVE',
        phone: ADMIN_PHONE,
        firstName: 'Ngozi',
        lastName: 'Okonkwo',
      },
    });
  } else {
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        accountStatus: 'ACTIVE',
        role: 'SCHOOL_ADMIN',
        firstName: 'Ngozi',
        lastName: 'Okonkwo',
      },
    });
  }

  let admin = await prisma.schoolAdmin.findFirst({ where: { userId: user.id, schoolId } });
  if (!admin) {
    admin = await prisma.schoolAdmin.create({
      data: {
        userId: user.id,
        schoolId,
        adminId: `AG-PR-${uuidv4().replace(/-/g, '').toUpperCase()}`,
        publicId: await uniquePublicId(SCHOOL_NAME),
        firstName: 'Ngozi',
        lastName: 'Okonkwo',
        phone: ADMIN_PHONE,
        email: ADMIN_EMAIL,
        role: 'school_owner',
        accessTier: 'PRINCIPAL',
      },
    });
    console.log(`Created school owner ${ADMIN_EMAIL}`);
  } else {
    console.log(`Reusing school owner ${ADMIN_EMAIL}`);
  }

  return { user, admin };
}

async function ensureSession(schoolId: string, schoolType: 'PRIMARY' | 'SECONDARY') {
  let session = await prisma.academicSession.findFirst({
    where: { schoolId, name: ACADEMIC_YEAR, schoolType },
  });
  if (!session) {
    session = await prisma.academicSession.create({
      data: {
        schoolId,
        name: ACADEMIC_YEAR,
        schoolType,
        startDate: new Date('2026-09-01'),
        endDate: new Date('2027-07-31'),
        status: SessionStatus.ACTIVE,
      },
    });
  } else if (session.status !== SessionStatus.ACTIVE) {
    session = await prisma.academicSession.update({
      where: { id: session.id },
      data: { status: SessionStatus.ACTIVE },
    });
  }

  let term = await prisma.term.findFirst({
    where: { academicSessionId: session.id, number: 1 },
  });
  if (!term) {
    term = await prisma.term.create({
      data: {
        academicSessionId: session.id,
        name: '1st Term',
        number: 1,
        startDate: new Date('2026-09-01'),
        endDate: new Date('2026-12-18'),
        status: TermStatus.ACTIVE,
      },
    });
  } else if (term.status !== TermStatus.ACTIVE) {
    term = await prisma.term.update({
      where: { id: term.id },
      data: { status: TermStatus.ACTIVE },
    });
  }

  return { session, term };
}

async function ensureLevelsAndArms(schoolId: string) {
  const created: Array<LevelDef & { classLevelId: string; classArmId: string }> = [];

  for (const level of LEVELS) {
    let classLevel = await prisma.classLevel.findFirst({
      where: { schoolId, code: level.code },
    });
    if (!classLevel) {
      classLevel = await prisma.classLevel.create({
        data: {
          schoolId,
          name: level.name,
          code: level.code,
          level: level.level,
          type: level.type,
          isActive: true,
        },
      });
    }

    let classArm = await prisma.classArm.findFirst({
      where: { classLevelId: classLevel.id, name: 'A', academicYear: ACADEMIC_YEAR },
    });
    if (!classArm) {
      classArm = await prisma.classArm.create({
        data: {
          classLevelId: classLevel.id,
          name: 'A',
          academicYear: ACADEMIC_YEAR,
          isActive: true,
        },
      });
    }

    created.push({ ...level, classLevelId: classLevel.id, classArmId: classArm.id });
  }

  for (let i = 0; i < created.length - 1; i++) {
    const current = created[i];
    const next = created[i + 1];
    if (current.type !== next.type) continue;
    await prisma.classLevel.update({
      where: { id: current.classLevelId },
      data: { nextLevelId: next.classLevelId },
    });
  }

  console.log(`Ensured ${created.length} class levels with arm A`);
  return created;
}

async function ensureStudents(
  schoolId: string,
  levels: Array<LevelDef & { classLevelId: string; classArmId: string }>,
  terms: Record<'PRIMARY' | 'SECONDARY', { id: string }>,
) {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const created: string[] = [];
  const skipped: string[] = [];
  let phoneSeq = 1010;

  for (const seed of STUDENTS) {
    const level = levels.find((l) => l.code === seed.classCode);
    if (!level) throw new Error(`Missing class ${seed.classCode}`);

    const email = studentEmail(seed);
    const existingUser = await prisma.user.findUnique({
      where: { email },
      include: { studentProfile: { include: { enrollments: { where: { schoolId } } } } },
    });
    if (existingUser?.studentProfile?.enrollments.length) {
      skipped.push(`${seed.firstName} ${seed.lastName} (${level.name})`);
      continue;
    }

    const studentPhone = `+23470188${String(phoneSeq++).padStart(5, '0')}`;
    const parentPhone = `+23470188${String(phoneSeq++).padStart(5, '0')}`;

    const parentParts = seed.parentName.split(' ');
    let parent = await prisma.parent.findFirst({ where: { phone: parentPhone } });
    if (!parent) {
      parent = await prisma.parent.create({
        data: {
          firstName: parentParts[0],
          lastName: parentParts.slice(1).join(' ') || seed.lastName,
          phone: parentPhone,
          email: `beulah.parent.${seed.firstName}.${seed.lastName}.${seed.classCode}`.toLowerCase() + '@agora.test',
          relationship: seed.parentRelationship,
        },
      });
    }

    const user = existingUser
      ? existingUser
      : await prisma.user.create({
          data: {
            email,
            phone: studentPhone,
            passwordHash,
            accountStatus: 'ACTIVE',
            role: 'STUDENT',
            firstName: seed.firstName,
            lastName: seed.lastName,
          },
        });

    const student = existingUser?.studentProfile
      ? existingUser.studentProfile
      : await prisma.student.create({
          data: {
            uid: await uniqueStudentUid(SCHOOL_NAME),
            publicId: await uniquePublicId(SCHOOL_NAME),
            firstName: seed.firstName,
            lastName: seed.lastName,
            dateOfBirth: studentDob(seed.classCode),
            nationality: 'Nigerian',
            state: seed.state,
            userId: user.id,
          },
        });

    const guardian = await prisma.studentGuardian.findUnique({
      where: { studentId_parentId: { studentId: student.id, parentId: parent.id } },
    });
    if (!guardian) {
      await prisma.studentGuardian.create({
        data: {
          studentId: student.id,
          parentId: parent.id,
          relationship: seed.parentRelationship,
          isPrimary: true,
        },
      });
    }

    const termId = terms[level.type].id;
    const existingEnrollment = await prisma.enrollment.findFirst({
      where: { studentId: student.id, schoolId, termId },
    });
    if (!existingEnrollment) {
      await prisma.enrollment.create({
        data: {
          studentId: student.id,
          schoolId,
          classArmId: level.classArmId,
          classLevel: level.name,
          academicYear: ACADEMIC_YEAR,
          isActive: true,
          termId,
        },
      });
    }

    created.push(`${seed.firstName} ${seed.lastName} → ${level.name} A`);
    console.log(`Student: ${seed.firstName} ${seed.lastName} (${level.name} A)`);
  }

  return { created, skipped };
}

let teacherPhoneSeq = 1;

async function migrateExistingBeulahEmails(schoolId: string, passwordHash: string) {
  // Teachers
  const teachers = await prisma.teacher.findMany({
    where: { schoolId },
    include: { user: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  for (const teacher of teachers) {
    if (!teacher.user) continue;
    const slug = `${slugify(teacher.firstName)}-${slugify(teacher.lastName)}-${teacher.userId.slice(-6)}`;
    const email = teacherEmail(slug);

    await prisma.user.update({
      where: { id: teacher.userId },
      data: {
        email,
        passwordHash,
        accountStatus: 'ACTIVE',
      },
    });

    if (teacher.email !== email) {
      await prisma.teacher.update({
        where: { id: teacher.id },
        data: { email },
      });
    }
  }

  // Students (all active/inactive enrollments in Beulah)
  const enrollments = await prisma.enrollment.findMany({
    where: { schoolId },
    include: {
      student: {
        include: { user: true },
      },
    },
  });

  const seenStudentIds = new Set<string>();
  for (const enr of enrollments) {
    const st = enr.student;
    if (!st?.user || seenStudentIds.has(st.id)) continue;
    seenStudentIds.add(st.id);

    const classCode =
      LEVELS.find((l) => l.name.toLowerCase() === enr.classLevel.toLowerCase())?.code.toLowerCase() ||
      'class';
    const slug = `${slugify(st.firstName)}-${slugify(st.lastName)}-${classCode}-${st.userId.slice(-6)}`;
    const email = `${EMAIL_ALIAS_BASE}+beulah-student-${slug}@gmail.com`;

    await prisma.user.update({
      where: { id: st.userId },
      data: {
        email,
        passwordHash,
        accountStatus: 'ACTIVE',
      },
    });
  }
}

async function uniqueTeacherPhone(): Promise<string> {
  for (let i = 0; i < 80; i++) {
    const phone = `+2348094${String(teacherPhoneSeq++).padStart(6, '0')}`;
    const taken = await prisma.user.findFirst({ where: { phone } });
    if (!taken) return phone;
  }
  return `+2348094${Date.now().toString().slice(-6)}`;
}

async function ensureTeacher(opts: {
  schoolId: string;
  email: string;
  firstName: string;
  lastName: string;
  schoolType: 'PRIMARY' | 'SECONDARY';
  subject?: string;
  passwordHash: string;
}) {
  let user = await prisma.user.findUnique({ where: { email: opts.email } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        email: opts.email,
        phone: await uniqueTeacherPhone(),
        passwordHash: opts.passwordHash,
        accountStatus: 'ACTIVE',
        role: 'TEACHER',
        firstName: opts.firstName,
        lastName: opts.lastName,
      },
    });
  } else {
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: opts.passwordHash,
        accountStatus: 'ACTIVE',
        firstName: opts.firstName,
        lastName: opts.lastName,
      },
    });
  }

  let teacher = await prisma.teacher.findFirst({
    where: { userId: user.id, schoolId: opts.schoolId },
  });
  if (!teacher) {
    const phone = user.phone || (await uniqueTeacherPhone());
    teacher = await prisma.teacher.create({
      data: {
        userId: user.id,
        schoolId: opts.schoolId,
        teacherId: `AG-TE-${uuidv4().replace(/-/g, '').toUpperCase()}`,
        publicId: await uniquePublicId(SCHOOL_NAME),
        firstName: opts.firstName,
        lastName: opts.lastName,
        phone,
        email: opts.email,
        subject: opts.subject || null,
        schoolType: opts.schoolType,
      },
    });
    console.log(`Teacher: ${opts.firstName} ${opts.lastName} (${opts.subject || opts.schoolType})`);
    return { teacher, created: true };
  }

  return { teacher, created: false };
}

async function ensurePrimaryTeachers(
  schoolId: string,
  levels: Array<LevelDef & { classLevelId: string; classArmId: string }>,
  sessionId: string,
  passwordHash: string,
) {
  let created = 0;
  let skipped = 0;

  for (const seed of PRIMARY_CLASS_TEACHERS) {
    const level = levels.find((l) => l.code === seed.classCode);
    if (!level) throw new Error(`Missing class ${seed.classCode}`);

    const { teacher, created: wasCreated } = await ensureTeacher({
      schoolId,
      email: teacherEmail(`pri${level.level}`),
      firstName: seed.firstName,
      lastName: seed.lastName,
      schoolType: 'PRIMARY',
      subject: 'Class Teacher',
      passwordHash,
    });
    if (wasCreated) created++;
    else skipped++;

    const existing = await prisma.classTeacher.findFirst({
      where: {
        classArmId: level.classArmId,
        teacherId: teacher.id,
        isPrimary: true,
      },
    });
    if (!existing) {
      await prisma.classTeacher.create({
        data: {
          classArmId: level.classArmId,
          teacherId: teacher.id,
          sessionId,
          isPrimary: true,
          subject: 'Class Teacher',
        },
      });
    }

    await prisma.classArm.update({
      where: { id: level.classArmId },
      data: { classTeacherId: teacher.id },
    });
  }

  console.log(`Primary class teachers: ${created} created, ${skipped} already present`);
  return { created, skipped };
}

async function ensureSecondarySubjects(schoolId: string) {
  const subjects: Array<{ id: string; name: string; code: string }> = [];
  for (const def of SECONDARY_SUBJECTS) {
    let subject = await prisma.subject.findFirst({
      where: { schoolId, code: def.code, schoolType: 'SECONDARY' },
    });
    if (!subject) {
      subject = await prisma.subject.create({
        data: {
          schoolId,
          name: def.name,
          code: def.code,
          schoolType: 'SECONDARY',
          isActive: true,
          category: SECONDARY_CORE_CODES.has(def.code) ? 'CORE' : 'ELECTIVE',
          levelStream: 'ALL',
        },
      });
      console.log(`Subject: ${def.name}`);
    }
    subjects.push({ id: subject.id, name: subject.name, code: subject.code || def.code });
  }
  return subjects;
}

async function ensureSecondaryTeachers(
  schoolId: string,
  subjects: Array<{ id: string; name: string; code: string }>,
  secondaryLevels: Array<LevelDef & { classArmId: string }>,
  sessionId: string,
  passwordHash: string,
) {
  let created = 0;
  let skipped = 0;
  let nameIndex = 0;

  for (const subject of subjects) {
    const count = teacherCountForSubject(subject.code);
    const teachersForSubject: { id: string }[] = [];

    for (let n = 1; n <= count; n++) {
      const name = secondaryTeacherName(nameIndex++);
      const { teacher, created: wasCreated } = await ensureTeacher({
        schoolId,
        email: teacherEmail(`${subject.code}${n}`),
        firstName: name.firstName,
        lastName: name.lastName,
        schoolType: 'SECONDARY',
        subject: subject.name,
        passwordHash,
      });
      if (wasCreated) created++;
      else skipped++;
      teachersForSubject.push(teacher);

      const linked = await prisma.subjectTeacher.findUnique({
        where: {
          subjectId_teacherId: { subjectId: subject.id, teacherId: teacher.id },
        },
      });
      if (!linked) {
        await prisma.subjectTeacher.create({
          data: { subjectId: subject.id, teacherId: teacher.id },
        });
      }
    }

    for (let i = 0; i < secondaryLevels.length; i++) {
      const arm = secondaryLevels[i];
      const teacher = teachersForSubject[i % teachersForSubject.length];
      const existing = await prisma.classTeacher.findFirst({
        where: {
          classArmId: arm.classArmId,
          subjectId: subject.id,
          sessionId,
        },
      });
      if (!existing) {
        await prisma.classTeacher.create({
          data: {
            classArmId: arm.classArmId,
            teacherId: teacher.id,
            subjectId: subject.id,
            subject: subject.name,
            sessionId,
            isPrimary: false,
            isFormTeacher: false,
          },
        });
      }
    }
  }

  console.log(`Secondary subject teachers: ${created} created, ${skipped} already present`);
  return { created, skipped };
}

async function main() {
  console.log(`Seeding ${SCHOOL_NAME}...`);
  const school = await ensureSchool();
  await ensureAdmin(school.id);
  const sharedPasswordHash = await bcrypt.hash(PASSWORD, 10);
  await migrateExistingBeulahEmails(school.id, sharedPasswordHash);
  const primarySession = await ensureSession(school.id, 'PRIMARY');
  const secondarySession = await ensureSession(school.id, 'SECONDARY');
  const levels = await ensureLevelsAndArms(school.id);
  const { created, skipped } = await ensureStudents(school.id, levels, {
    PRIMARY: primarySession.term,
    SECONDARY: secondarySession.term,
  });

  const passwordHash = sharedPasswordHash;
  const primaryTeachers = await ensurePrimaryTeachers(
    school.id,
    levels.filter((l) => l.type === 'PRIMARY'),
    primarySession.session.id,
    passwordHash,
  );
  const subjects = await ensureSecondarySubjects(school.id);
  const secondaryTeachers = await ensureSecondaryTeachers(
    school.id,
    subjects,
    levels.filter((l) => l.type === 'SECONDARY'),
    secondarySession.session.id,
    passwordHash,
  );

  const enrollmentCount = await prisma.enrollment.count({
    where: { schoolId: school.id, isActive: true },
  });
  const teacherCount = await prisma.teacher.count({ where: { schoolId: school.id } });
  const sampleTeachers = await prisma.teacher.findMany({
    where: { schoolId: school.id },
    select: { firstName: true, lastName: true, email: true, subject: true },
    orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
    take: 6,
  });
  const sampleStudents = await prisma.enrollment.findMany({
    where: { schoolId: school.id, isActive: true },
    include: {
      student: { include: { user: { select: { email: true } } } },
    },
    orderBy: [{ classLevel: 'asc' }, { createdAt: 'asc' }],
    take: 6,
  });

  console.log('\n=== Beulah High School ===');
  console.log(`School ID: ${school.id}`);
  console.log(`Admin: ${ADMIN_EMAIL} / ${PASSWORD}`);
  console.log(`Classes: ${levels.length} (Primary 1–6, JSS 1–3, SS 1–3)`);
  console.log(`Students created: ${created.length}`);
  console.log(`Students skipped (already enrolled): ${skipped.length}`);
  console.log(`Active enrollments: ${enrollmentCount}`);
  console.log(`Primary class teachers created: ${primaryTeachers.created}`);
  console.log(`Secondary subject teachers created: ${secondaryTeachers.created}`);
  console.log(`Total teachers: ${teacherCount}`);
  console.log(`Teacher login password: ${PASSWORD}`);
  console.log('\nSample teacher logins:');
  sampleTeachers.forEach((t) => {
    console.log(`- ${t.firstName} ${t.lastName} (${t.subject || 'Teacher'}): ${t.email} / ${PASSWORD}`);
  });
  console.log('\nSample student logins:');
  sampleStudents.forEach((e) => {
    console.log(
      `- ${e.student.firstName} ${e.student.lastName} (${e.classLevel}): ${e.student.user?.email || 'no-email'} / ${PASSWORD}`,
    );
  });
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
