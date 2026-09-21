-- Named access bundles become first-class, and admins remember which one they hold.
--
-- `RoleTemplate` already existed (school settings) but nothing used it: no rows,
-- no UI. Rather than stand up a second table for the same idea, it is extended
-- here to carry platform built-ins (schoolId NULL) and a suggested job title.
--
-- Why this matters: schools were re-deriving the same tick-boxes for every hire,
-- with no name for the result, so nobody could say what a "Bursar" should see.

ALTER TABLE "RoleTemplate" ALTER COLUMN "schoolId" DROP NOT NULL;
ALTER TABLE "RoleTemplate" ADD COLUMN IF NOT EXISTS "slug" TEXT;
ALTER TABLE "RoleTemplate" ADD COLUMN IF NOT EXISTS "suggestedRole" TEXT;

-- One slug per school, and (via the partial index) one per platform built-in,
-- since NULL schoolId values do not collide in a plain unique index.
CREATE UNIQUE INDEX IF NOT EXISTS "RoleTemplate_schoolId_slug_key" ON "RoleTemplate"("schoolId", "slug");
CREATE UNIQUE INDEX IF NOT EXISTS "RoleTemplate_builtin_name_key" ON "RoleTemplate"("name") WHERE "schoolId" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "RoleTemplate_builtin_slug_key" ON "RoleTemplate"("slug") WHERE "schoolId" IS NULL;

-- Which bundle an admin was given, and whether their rows were hand-edited
-- since. Existing admins hold no template: their access predates the idea, and
-- guessing one would misreport what they actually have.
ALTER TABLE "SchoolAdmin" ADD COLUMN IF NOT EXISTS "roleTemplateId" TEXT;
ALTER TABLE "SchoolAdmin" ADD COLUMN IF NOT EXISTS "templateCustomised" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "SchoolAdmin_roleTemplateId_idx" ON "SchoolAdmin"("roleTemplateId");

DO $$ BEGIN
  ALTER TABLE "SchoolAdmin"
    ADD CONSTRAINT "SchoolAdmin_roleTemplateId_fkey"
    FOREIGN KEY ("roleTemplateId") REFERENCES "RoleTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
