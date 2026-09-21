/**
 * Upsert Beulah bursar / empty-permission / VP admins on the owner school.
 * Honors empty permission arrays (unlike AdminService.addAdmin omitted-array default).
 *
 * Run from backend: npx tsx scripts/seed-beulah-access-admins.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { PrismaClient, PermissionResource, PermissionType } from '@prisma/client';
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

function slugId(prefix: string, key: string) {
  return `${prefix}-${key}-${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
}

async function uniqueAdminId(prefix: 'AG-AD' | 'AG-BEU') {
  for (let i = 0; i < 8; i += 1) {
    const adminId = slugId(prefix, 'E2E');
    const hit = await prisma.schoolAdmin.findFirst({ where: { adminId } });
    if (!hit) return adminId;
  }
  throw new Error('Could not mint a unique adminId');
}

async function uniquePublicId(schoolName: string, key: string) {
  const short = schoolName.replace(/[^a-zA-Z]/g, '').slice(0, 6).toUpperCase() || 'BEU';
  for (let i = 0; i < 8; i += 1) {
    const publicId = `AG-${short}-${key.slice(0, 3).toUpperCase()}${randomUUID().slice(0, 4).toUpperCase()}`;
    const hit = await prisma.schoolAdmin.findFirst({ where: { publicId } });
    if (!hit) return publicId;
  }
  throw new Error('Could not mint a unique publicId');
}

async function upsertProfile(
  school: { id: string; name: string },
  profile: (typeof BEULAH_ACCESS_PROFILES)[number],
) {
  const email = profile.email.trim().toLowerCase();
  let user = await prisma.user.findUnique({ where: { email } });
  const phoneOwner = await prisma.user.findFirst({
    where: { phone: profile.phone, NOT: { email } },
  });
  const phone = phoneOwner ? `23480901${String(Date.now()).slice(-5)}` : profile.phone;

  if (!user) {
    user = await prisma.user.create({
      data: {
        email,
        phone,
        accountStatus: 'ACTIVE',
        role: 'SCHOOL_ADMIN',
      },
    });
  } else {
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        accountStatus: 'ACTIVE',
        role: 'SCHOOL_ADMIN',
        ...(phoneOwner ? {} : { phone }),
      },
    });
  }

  let admin = await prisma.schoolAdmin.findUnique({
    where: { userId_schoolId: { userId: user.id, schoolId: school.id } },
  });

  if (!admin) {
    admin = await prisma.schoolAdmin.create({
      data: {
        adminId: await uniqueAdminId('AG-AD'),
        publicId: await uniquePublicId(school.name, profile.key),
        firstName: profile.firstName,
        lastName: profile.lastName,
        phone,
        email,
        role: profile.role,
        accessTier: profile.accessTier,
        schoolType: profile.schoolType,
        userId: user.id,
        schoolId: school.id,
      },
    });
  } else {
    admin = await prisma.schoolAdmin.update({
      where: { id: admin.id },
      data: {
        firstName: profile.firstName,
        lastName: profile.lastName,
        email,
        role: profile.role,
        // Re-assert the tier: a previous run (or a test that promoted someone)
        // must not leave a QA account with a permission bypass.
        accessTier: profile.accessTier,
        schoolType: profile.schoolType,
        ...(phoneOwner ? {} : { phone }),
      },
    });
  }

  await prisma.staffPermission.deleteMany({ where: { adminId: admin.id } });

  const granted: string[] = [];
  for (const perm of profile.permissions) {
    const row = await prisma.permission.findUnique({
      where: {
        resource_type: {
          resource: perm.resource as PermissionResource,
          type: perm.type as PermissionType,
        },
      },
    });
    if (!row) {
      throw new Error(`Missing Permission row ${perm.resource}:${perm.type}`);
    }
    await prisma.staffPermission.create({
      data: { adminId: admin.id, permissionId: row.id },
    });
    granted.push(`${perm.resource}:${perm.type}`);
  }

  return {
    key: profile.key,
    email,
    role: admin.role,
    schoolType: admin.schoolType,
    permissions: granted,
    adminId: admin.id,
    userId: user.id,
  };
}

async function main() {
  const school = await prisma.school.findUnique({
    where: { id: BEULAH_SCHOOL_ID },
    select: { id: true, name: true },
  });
  if (!school) {
    throw new Error(`Beulah school not found: ${BEULAH_SCHOOL_ID}`);
  }

  const seeded = [];
  for (const profile of BEULAH_ACCESS_PROFILES) {
    seeded.push(await upsertProfile(school, profile));
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        school: school.name,
        schoolId: school.id,
        admins: seeded,
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
