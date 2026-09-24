/**
 * Mint Playwright storageState for Beulah teacher-dashboard QA.
 * Skips OTP. Writes frontend/e2e/.auth/beulah-teacher-*.json
 *
 * Run from backend: npx tsx scripts/mint-beulah-teacher-auth.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import * as jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const prisma = new PrismaClient();
const FRONTEND_ORIGIN = process.env.E2E_BASE_URL || 'http://localhost:3000';
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-this-in-production';
const AUTH_DIR = path.resolve(__dirname, '../../frontend/e2e/.auth');

const TARGETS = [
  {
    email: 'remyarinze+beulah-teacher-adaeze-okeke-7xirdt@gmail.com',
    file: 'beulah-teacher-adaeze.json',
    label: 'adaeze',
  },
  {
    email: 'remyarinze+beulah-teacher-femi-adebayo-89yysb@gmail.com',
    file: 'beulah-teacher-femi.json',
    label: 'femi',
  },
  {
    email: 'remyarinze+beulah-teacher-abubakar-adebayo-p40fze@gmail.com',
    file: 'beulah-teacher-abubakar.json',
    label: 'abubakar',
  },
] as const;

function mintTokens(payload: Record<string, unknown>) {
  const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' });
  const refreshToken = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
  return { accessToken, refreshToken };
}

async function main() {
  const results: Array<Record<string, string>> = [];

  for (const target of TARGETS) {
    const teacher = await prisma.teacher.findFirst({
      where: { OR: [{ email: target.email }, { user: { email: target.email } }] },
      include: { user: true },
    });
    if (!teacher?.user) throw new Error(`Teacher not found: ${target.email}`);

    const pwdChangedAt = teacher.user.passwordChangedAt
      ? Math.floor(teacher.user.passwordChangedAt.getTime() / 1000)
      : undefined;

    const payload = {
      sub: teacher.user.id,
      role: 'TEACHER',
      schoolId: teacher.schoolId,
      publicId: teacher.publicId,
      profileId: teacher.id,
      ...(pwdChangedAt !== undefined ? { pwdChangedAt } : {}),
    };
    const { accessToken, refreshToken } = mintTokens(payload);

    const authUser = {
      id: teacher.user.id,
      email: teacher.user.email,
      phone: teacher.user.phone || teacher.phone,
      role: 'TEACHER',
      accountStatus: teacher.user.accountStatus,
      firstName: teacher.firstName,
      lastName: teacher.lastName,
      profileId: teacher.id,
      publicId: teacher.publicId,
      schoolId: teacher.schoolId,
      tenantId: teacher.schoolId,
    };

    const persistAuth = {
      user: JSON.stringify(authUser),
      token: JSON.stringify(accessToken),
      refreshToken: JSON.stringify(refreshToken),
      tenantId: JSON.stringify(teacher.schoolId),
      _persist: JSON.stringify({ version: -1, rehydrated: true }),
    };

    const storage = {
      cookies: [
        {
          name: 'refresh_token',
          value: refreshToken,
          domain: 'localhost',
          path: '/',
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
        },
      ],
      origins: [
        {
          origin: FRONTEND_ORIGIN,
          localStorage: [
            { name: 'persist:auth', value: JSON.stringify(persistAuth) },
            { name: 'currentSchoolId', value: teacher.schoolId },
            { name: 'tenantId', value: teacher.schoolId },
          ],
        },
      ],
    };

    const out = path.join(AUTH_DIR, target.file);
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    fs.writeFileSync(out, JSON.stringify(storage, null, 2));
    results.push({
      label: target.label,
      name: `${teacher.firstName} ${teacher.lastName}`,
      schoolType: teacher.schoolType || '',
      auth: target.file,
    });
  }

  console.log(JSON.stringify({ ok: true, results }, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
