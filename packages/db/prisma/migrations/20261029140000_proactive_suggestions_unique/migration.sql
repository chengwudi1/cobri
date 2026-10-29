CREATE UNIQUE INDEX "proactive_suggestions_spaceId_userId_source_botId_title_key"
  ON "proactive_suggestions"("spaceId", "userId", "source", "botId", "title");
