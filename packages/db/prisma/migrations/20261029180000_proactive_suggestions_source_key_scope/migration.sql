-- One suggestion per source and day, even if the model picks a different target bot.
-- Rows that already repeat a sourceKey in a bucket keep their history under a unique legacy key.
WITH ranked AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "spaceId", "userId", "sourceKey", "bucket"
      ORDER BY "createdAt" DESC, "id" DESC
    ) AS position
  FROM "proactive_suggestions"
)
UPDATE "proactive_suggestions" AS suggestion
SET "sourceKey" = suggestion."sourceKey" || ':legacy:' || suggestion."id"
FROM ranked
WHERE suggestion."id" = ranked."id" AND ranked.position > 1;

DROP INDEX "proactive_suggestions_spaceId_userId_sourceKey_botId_bucket_key";

CREATE UNIQUE INDEX "proactive_suggestions_spaceId_userId_sourceKey_bucket_key"
  ON "proactive_suggestions"("spaceId", "userId", "sourceKey", "bucket");
