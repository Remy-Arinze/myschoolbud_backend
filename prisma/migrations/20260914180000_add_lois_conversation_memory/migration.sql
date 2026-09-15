-- Durable Lois thread slots (last job, classes, pending clarify) across turns.
ALTER TABLE "ChatConversation" ADD COLUMN IF NOT EXISTS "loisMemory" JSONB;
