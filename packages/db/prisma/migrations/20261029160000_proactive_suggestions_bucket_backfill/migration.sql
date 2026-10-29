UPDATE "proactive_suggestions" AS s
SET "bucket" = to_char(
  s."createdAt" AT TIME ZONE COALESCE(NULLIF(u."timezone", ''), 'UTC'),
  'YYYY-MM-DD'
)
FROM "user" AS u
WHERE u."id" = s."userId" AND s."bucket" = '';
