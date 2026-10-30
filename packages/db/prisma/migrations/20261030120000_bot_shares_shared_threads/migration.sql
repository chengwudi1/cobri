-- Shared bots: a share makes one Bot visible to the rest of its Space, and each
-- member gets a private SharedThread container. Neither table existed in the
-- previous release, so no *_previous_release policy is needed: the old code
-- never reads them.

CREATE TABLE "bot_shares" (
  "id" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "sharedBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "bot_shares_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "shared_threads" (
  "id" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "shared_threads_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "bot_shares_botId_spaceId_key" ON "bot_shares"("botId", "spaceId");
CREATE INDEX "bot_shares_spaceId_sharedBy_idx" ON "bot_shares"("spaceId", "sharedBy");
CREATE UNIQUE INDEX "shared_threads_botId_userId_key" ON "shared_threads"("botId", "userId");
CREATE INDEX "shared_threads_spaceId_userId_createdAt_idx"
  ON "shared_threads"("spaceId", "userId", "createdAt");

ALTER TABLE "bot_shares" ADD CONSTRAINT "bot_shares_botId_fkey"
  FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bot_shares" ADD CONSTRAINT "bot_shares_spaceId_fkey"
  FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shared_threads" ADD CONSTRAINT "shared_threads_botId_fkey"
  FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shared_threads" ADD CONSTRAINT "shared_threads_spaceId_fkey"
  FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "bot_shares" ENABLE ROW LEVEL SECURITY;

-- Every member of the Space can see who shared which bot.
CREATE POLICY bot_shares_member ON "bot_shares" FOR SELECT
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));

-- Only a bot's owner can share or unshare it, and only inside its own Space.
-- The app checks the same rule; this keeps the data layer honest on its own.
CREATE POLICY bot_shares_owner_write ON "bot_shares" FOR ALL
  USING (
    "spaceId" = NULLIF(current_setting('app.space_id', true), '')
    AND "sharedBy" = NULLIF(current_setting('app.user_id', true), '')
    AND EXISTS (
      SELECT 1 FROM "bots" b
      WHERE b."id" = "bot_shares"."botId"
        AND b."userId" = NULLIF(current_setting('app.user_id', true), '')
    )
  )
  WITH CHECK (
    "spaceId" = NULLIF(current_setting('app.space_id', true), '')
    AND "sharedBy" = NULLIF(current_setting('app.user_id', true), '')
    AND EXISTS (
      SELECT 1 FROM "bots" b
      WHERE b."id" = "bot_shares"."botId"
        AND b."userId" = NULLIF(current_setting('app.user_id', true), '')
    )
  );

CREATE POLICY bot_shares_system ON "bot_shares"
  USING (current_setting('app.rls_bypass', true) = 'on');

ALTER TABLE "shared_threads" ENABLE ROW LEVEL SECURITY;

-- A container is visible only to the member who owns it. SELECT stays available
-- after an unshare (read-only history); every mutation -- INSERT, UPDATE and
-- DELETE -- additionally needs a live share, so an unshared bot can neither gain
-- new containers nor lose or rewrite the ones already kept.
CREATE POLICY shared_threads_owner_read ON "shared_threads" FOR SELECT
  USING (
    "spaceId" = NULLIF(current_setting('app.space_id', true), '')
    AND "userId" = NULLIF(current_setting('app.user_id', true), '')
  );

CREATE POLICY shared_threads_owner_insert ON "shared_threads" FOR INSERT
  WITH CHECK (
    "spaceId" = NULLIF(current_setting('app.space_id', true), '')
    AND "userId" = NULLIF(current_setting('app.user_id', true), '')
    AND EXISTS (
      SELECT 1 FROM "bot_shares" s
      WHERE s."botId" = "shared_threads"."botId"
        AND s."spaceId" = NULLIF(current_setting('app.space_id', true), '')
    )
  );

CREATE POLICY shared_threads_owner_update ON "shared_threads" FOR UPDATE
  USING (
    "spaceId" = NULLIF(current_setting('app.space_id', true), '')
    AND "userId" = NULLIF(current_setting('app.user_id', true), '')
    AND EXISTS (
      SELECT 1 FROM "bot_shares" s
      WHERE s."botId" = "shared_threads"."botId"
        AND s."spaceId" = NULLIF(current_setting('app.space_id', true), '')
    )
  )
  WITH CHECK (
    "spaceId" = NULLIF(current_setting('app.space_id', true), '')
    AND "userId" = NULLIF(current_setting('app.user_id', true), '')
    AND EXISTS (
      SELECT 1 FROM "bot_shares" s
      WHERE s."botId" = "shared_threads"."botId"
        AND s."spaceId" = NULLIF(current_setting('app.space_id', true), '')
    )
  );

CREATE POLICY shared_threads_owner_delete ON "shared_threads" FOR DELETE
  USING (
    "spaceId" = NULLIF(current_setting('app.space_id', true), '')
    AND "userId" = NULLIF(current_setting('app.user_id', true), '')
    AND EXISTS (
      SELECT 1 FROM "bot_shares" s
      WHERE s."botId" = "shared_threads"."botId"
        AND s."spaceId" = NULLIF(current_setting('app.space_id', true), '')
    )
  );

CREATE POLICY shared_threads_system ON "shared_threads"
  USING (current_setting('app.rls_bypass', true) = 'on');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "bot_shares" TO rakazo_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "shared_threads" TO rakazo_app;
  END IF;
END $$;
