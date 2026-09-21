-- Authority stops being text.
--
-- `SchoolAdmin.role` was doing two jobs: the label a school reads, and the
-- switch that bypasses the whole permission system. That meant spelling decided
-- authority — "Head Teacher" granted everything, "Headteacher" granted nothing.
-- `accessTier` is now the only authority signal; `role` stays as the title.

DO $$ BEGIN
  CREATE TYPE "AdminAccessTier" AS ENUM ('PRINCIPAL', 'STAFF');
EXCEPTION WHEN duplicate_object THEN null; END $$;

ALTER TABLE "SchoolAdmin"
  ADD COLUMN IF NOT EXISTS "accessTier" "AdminAccessTier" NOT NULL DEFAULT 'STAFF';

-- Backfill mirrors normalizeRoleKey() exactly (lower, trim, whitespace runs to
-- underscores) so nobody's effective access changes on deploy. Titles that never
-- matched before (e.g. "Headteacher") stay STAFF — preserved, not silently fixed.
UPDATE "SchoolAdmin"
SET "accessTier" = 'PRINCIPAL'
WHERE lower(regexp_replace(btrim("role"), '\s+', '_', 'g')) IN (
  'principal',
  'school_principal',
  'head_teacher',
  'headmaster',
  'headmistress',
  'school_owner'
);

CREATE INDEX IF NOT EXISTS "SchoolAdmin_accessTier_idx" ON "SchoolAdmin"("accessTier");
