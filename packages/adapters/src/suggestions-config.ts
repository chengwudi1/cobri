export type SuggestionBotRole = "primary" | "inbox" | "calendar";

export const SUGGESTION_BOT_ROLES: readonly SuggestionBotRole[] = [
  "primary",
  "inbox",
  "calendar",
];

export type SuggestionBot = {
  id: string;
  name: string;
  color: string;
  spawnKey: string | null;
};

export type SuggestionTargets = {
  primary: SuggestionBot;
  inbox?: SuggestionBot;
  calendar?: SuggestionBot;
};

// Bot roles are carried by the spawn key a space's team was created with, so a
// renamed bot keeps its job and a space without these roles reads as empty.
const ROLE_BY_SPAWN_SUFFIX: Record<string, SuggestionBotRole> = {
  first: "primary",
  chief: "primary",
  primary: "primary",
  orchestrator: "primary",
  inbox: "inbox",
  mail: "inbox",
  email: "inbox",
  calendar: "calendar",
  schedule: "calendar",
  scheduling: "calendar",
};

function spawnSuffix(spawnKey: string | null): string {
  return spawnKey?.trim().toLowerCase().split(":").pop() ?? "";
}

export function inferSuggestionTargets(bots: SuggestionBot[]): SuggestionTargets | null {
  const found: Partial<Record<SuggestionBotRole, SuggestionBot>> = {};
  for (const bot of bots) {
    const role = ROLE_BY_SPAWN_SUFFIX[spawnSuffix(bot.spawnKey)];
    if (role && !found[role]) found[role] = bot;
  }
  if (!found.primary) return null;
  return { primary: found.primary, inbox: found.inbox, calendar: found.calendar };
}

/** Suggestions may reappear in a later window; within one window the unique key dedupes. */
export function suggestionBucket(date = new Date(), timeZone = "UTC"): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}
