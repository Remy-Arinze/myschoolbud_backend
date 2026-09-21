import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const cols = await prisma.$queryRawUnsafe<any[]>(
    `SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
     WHERE table_name IN ('RoleTemplate','RoleTemplatePermission') ORDER BY table_name, ordinal_position`,
  );
  console.log(JSON.stringify(cols, null, 2));
  const rows = await prisma.$queryRawUnsafe<any[]>(`SELECT count(*)::int AS n FROM "RoleTemplate"`);
  console.log('RoleTemplate rows:', JSON.stringify(rows));
  const adminCols = await prisma.$queryRawUnsafe<any[]>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'SchoolAdmin' AND column_name IN ('roleTemplateId','templateCustomised')`,
  );
  console.log('SchoolAdmin new cols:', JSON.stringify(adminCols));
}
main().finally(() => prisma.$disconnect());
