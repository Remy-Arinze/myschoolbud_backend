/**
 * Confirms the accessTier backfill agrees with the old string rule, one row at a
 * time. Any disagreement is a real change in someone's authority and must be
 * looked at rather than deployed.
 *
 * Run: npx tsx scripts/verify-access-tier-backfill.ts
 */
import { PrismaClient } from '@prisma/client';
import { isPrincipalRole } from '../src/schools/dto/permission.dto';

const prisma = new PrismaClient();

async function main() {
  const admins = await prisma.schoolAdmin.findMany({
    select: { id: true, role: true, accessTier: true, schoolId: true, email: true },
  });

  const disagreements = admins.filter(
    (a) => isPrincipalRole(a.role) !== (a.accessTier === 'PRINCIPAL'),
  );

  const principals = admins.filter((a) => a.accessTier === 'PRINCIPAL');

  console.log(`admins:            ${admins.length}`);
  console.log(`tier = PRINCIPAL:  ${principals.length}`);
  console.log(`tier = STAFF:      ${admins.length - principals.length}`);
  console.log(`disagreements:     ${disagreements.length}`);

  if (disagreements.length > 0) {
    console.log('\nRows where the backfill disagrees with isPrincipalRole(role):');
    for (const row of disagreements) {
      console.log(`  ${row.id}  role="${row.role}"  tier=${row.accessTier}  ${row.email ?? ''}`);
    }
    process.exitCode = 1;
  }

  // Titles that read as principal-level to a human but never matched the string
  // rule. These stay STAFF (behaviour preserved) and are worth reporting.
  const nearMisses = admins.filter(
    (a) =>
      a.accessTier === 'STAFF' &&
      /^(head\s*-?\s*teacher|head\s*master|head\s*mistress|principal|proprietor|proprietress|hm)$/i.test(
        (a.role || '').trim(),
      ),
  );
  if (nearMisses.length > 0) {
    console.log('\nPrincipal-sounding titles left as STAFF (unchanged, report to school):');
    for (const row of nearMisses) {
      console.log(`  ${row.id}  role="${row.role}"  school=${row.schoolId}`);
    }
  }

  const byRole = new Map<string, { principal: number; staff: number }>();
  for (const a of admins) {
    const key = a.role || '(empty)';
    const seen = byRole.get(key) ?? { principal: 0, staff: 0 };
    if (a.accessTier === 'PRINCIPAL') seen.principal += 1;
    else seen.staff += 1;
    byRole.set(key, seen);
  }
  console.log('\nTier by stored title:');
  for (const [role, counts] of [...byRole.entries()].sort()) {
    console.log(`  ${role.padEnd(24)} PRINCIPAL=${counts.principal} STAFF=${counts.staff}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
