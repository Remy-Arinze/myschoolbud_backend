/**
 * Mint Playwright storageState for Beulah High School owner (Arinze).
 * Skips OTP. Writes: frontend/e2e/.auth/beulah-admin.json
 *
 * Run from backend: npx tsx scripts/mint-beulah-admin-auth.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import * as jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([^#=]+)=(.*)$/);
    if (m && process.env[m[1].trim()] === undefined) {
      process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
}

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DB_URL } } });
const FRONTEND_ORIGIN = process.env.E2E_BASE_URL || 'http://localhost:3000';
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-this-in-production';
const AUTH_FILE = path.resolve(__dirname, '../../frontend/e2e/.auth/beulah-admin.json');
const ADMIN_EMAIL = process.env.E2E_BEULAH_ADMIN_EMAIL || 'remyarinze+beuadmin@gmail.com';

function mintTokens(payload: Record<string, unknown>) {
  const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' });
  const refreshToken = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
  return { accessToken, refreshToken };
}

async function main() {
  const admin = await prisma.schoolAdmin.findFirst({
    where: {
      OR: [{ email: ADMIN_EMAIL }, { user: { email: ADMIN_EMAIL } }],
    },
    include: { user: true, school: { select: { id: true, name: true } } },
  });

  if (!admin?.user) {
    throw new Error(`Beulah admin not found: ${ADMIN_EMAIL}`);
  }

  const pwdChangedAt = admin.user.passwordChangedAt
    ? Math.floor(admin.user.passwordChangedAt.getTime() / 1000)
    : undefined;

  const payload = {
    sub: admin.user.id,
    role: 'SCHOOL_ADMIN',
    schoolId: admin.schoolId,
    publicId: admin.publicId,
    profileId: admin.id,
    contextRole: admin.role,
    ...(pwdChangedAt !== undefined ? { pwdChangedAt } : {}),
  };
  const { accessToken, refreshToken } = mintTokens(payload);

  const authUser = {
    id: admin.user.id,
    email: admin.user.email,
    phone: admin.user.phone || admin.phone,
    role: 'SCHOOL_ADMIN',
    accountStatus: admin.user.accountStatus,
    firstName: admin.firstName,
    lastName: admin.lastName,
    profileId: admin.id,
    publicId: admin.publicId,
    schoolId: admin.schoolId,
    tenantId: admin.schoolId,
    adminRole: admin.role,
    adminSchoolType: admin.schoolType,
  };

  const persistAuth = {
    user: JSON.stringify(authUser),
    token: JSON.stringify(accessToken),
    refreshToken: JSON.stringify(refreshToken),
    tenantId: JSON.stringify(admin.schoolId),
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
          { name: 'currentSchoolId', value: admin.schoolId },
          { name: 'tenantId', value: admin.schoolId },
        ],
      },
    ],
  };

  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(storage, null, 2));

  console.log(
    JSON.stringify(
      {
        ok: true,
        email: admin.user.email,
        name: `${admin.firstName} ${admin.lastName}`,
        school: admin.school.name,
        schoolId: admin.schoolId,
        auth: AUTH_FILE,
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
