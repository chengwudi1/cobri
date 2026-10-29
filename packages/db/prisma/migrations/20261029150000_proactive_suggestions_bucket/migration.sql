ALTER TABLE "proactive_suggestions"
  ADD COLUMN "bucket" TEXT NOT NULL DEFAULT '';

DROP INDEX "proactive_suggestions_spaceId_userId_source_botId_title_key";

CREATE UNIQUE INDEX "proactive_suggestions_spaceId_userId_source_botId_title_bucket_key"
  ON "proactive_suggestions"("spaceId", "userId", "source", "botId", "title", "bucket");
