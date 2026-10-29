ALTER TABLE "proactive_suggestions"
  ADD COLUMN "sourceKey" TEXT NOT NULL DEFAULT '';

UPDATE "proactive_suggestions"
SET "sourceKey" = "source" || ':' || lower("title")
WHERE "sourceKey" = '';

DROP INDEX "proactive_suggestions_spaceId_userId_source_botId_title_bucket_key";

CREATE UNIQUE INDEX "proactive_suggestions_spaceId_userId_sourceKey_botId_bucket_key"
  ON "proactive_suggestions"("spaceId", "userId", "sourceKey", "botId", "bucket");
