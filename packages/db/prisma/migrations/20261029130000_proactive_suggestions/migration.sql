CREATE TABLE "proactive_suggestions" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "rationale" TEXT NOT NULL,
  "instruction" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "runId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "proactive_suggestions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "proactive_suggestions_spaceId_fkey" FOREIGN KEY ("spaceId")
    REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "proactive_suggestions_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "proactive_suggestions_botId_fkey" FOREIGN KEY ("botId")
    REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "proactive_suggestions_spaceId_userId_status_createdAt_idx"
  ON "proactive_suggestions"("spaceId", "userId", "status", "createdAt");

ALTER TABLE "proactive_suggestions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY proactive_suggestions_tenant ON "proactive_suggestions"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '')
    AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY proactive_suggestions_system ON "proactive_suggestions"
  USING (current_setting('app.rls_bypass', true) = 'on');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "proactive_suggestions" TO rakazo_app;
  END IF;
END $$;
