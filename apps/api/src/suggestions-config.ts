/**
 * Demo role mapping for suggestion targets. Per-Space suggestion settings can
 * replace this once the Primary Bot becomes configurable.
 */
export const SUGGESTION_BOT_NAMES = {
  primary: "总管",
  inbox: "收件箱",
  calendar: "日程",
} as const;

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
