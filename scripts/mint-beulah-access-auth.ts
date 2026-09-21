/**
 * Mint Playwright storageState for Beulah bursar / empty / VP (same school as owner).
 * Skips OTP. Writes frontend/e2e/.auth/beulah-{bursar,empty,vp}.json
 *
 * Run from backend: npx tsx scripts/mint-beulah-access-auth.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import * as jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { BEULAH_ACCESS_PROFILES, BEULAH_SCHOOL_ID } from './beulah-access-admins';

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
const AUTH_DIR = path.resolve(__dirname, '../../frontend/e2e/.auth');

function mintTokens(payload: Record<string, unknown>) {
  const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' });
  const refreshToken = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
  return { accessToken, refreshToken };
}

async function mintOne(email: string, authFileName: string) {
  const admin = await prisma.schoolAdmin.findFirst({
    where: {
      schoolId: BEULAH_SCHOOL_ID,
      OR: [{ email }, { user: { email } }],
    },
    include: { user: true, school: { select: { id: true, name: true } } },
  });

  if (!admin?.user) {
    throw new Error(`Beulah access admin not found: ${email}. Seed first.`);
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
    // The shell reads this, not the title, to decide the principal bypass.
    adminAccessTier: admin.accessTier,
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

  const authFile = path.join(AUTH_DIR, authFileName);
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  fs.writeFileSync(authFile, JSON.stringify(storage, null, 2));

  return {
    email: admin.user.email,
    role: admin.role,
    schoolType: admin.schoolType,
    auth: authFile,
  };
}

async function main() {
  const minted = [];
  for (const profile of BEULAH_ACCESS_PROFILES) {
    minted.push(await mintOne(profile.email, profile.authFile));
  }
  console.log(JSON.stringify({ ok: true, minted }, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
