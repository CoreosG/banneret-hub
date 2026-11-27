// Fork UI kit: dates in fixed English, whatever the system locale. Fork pages are English-only, so
// a locale date string (pt-BR on a Brazilian machine) would mix languages.
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function elapsedMs(at: string, nowMs: number): number | null {
  const elapsed = nowMs - Date.parse(at);
  return Number.isFinite(elapsed) ? Math.max(0, elapsed) : null;
}

/** "just now", "12 min ago", "3 h ago", "2 d ago". A future time reads "just now"; an unreadable one "". */
export function agoLabel(at: string, nowMs: number): string {
  const elapsed = elapsedMs(at, nowMs);
  if (elapsed === null) return "";
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h ago`;
  return `${Math.floor(elapsed / DAY)} d ago`;
}

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

const SHORT_DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const SHORT_DATE_YEAR = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

/**
 * How long a state has lasted, for "stuck for 1 day": "for 12 min", "for 3 hours", "for 2 days",
 * and "since Nov 20" once it is a week or older (with the year when it differs). "" for an
 * unreadable time.
 */
export function durationLabel(at: string, nowMs: number): string {
  const elapsed = elapsedMs(at, nowMs);
  if (elapsed === null) return "";
  if (elapsed < MINUTE) return "for under a minute";
  if (elapsed < HOUR) return `for ${Math.floor(elapsed / MINUTE)} min`;
  if (elapsed < DAY) return `for ${plural(Math.floor(elapsed / HOUR), "hour")}`;
  if (elapsed < 7 * DAY) return `for ${plural(Math.floor(elapsed / DAY), "day")}`;
  const ms = Date.parse(at);
  const sameYear = new Date(ms).getFullYear() === new Date(nowMs).getFullYear();
  return `since ${(sameYear ? SHORT_DATE : SHORT_DATE_YEAR).format(ms)}`;
}

/** "7 h", "2 d": how long something has been quiet; "" for an unreadable time. */
export function spanLabel(at: string, nowMs: number): string {
  const elapsed = elapsedMs(at, nowMs);
  if (elapsed === null) return "";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h`;
  return `${Math.floor(elapsed / DAY)} d`;
}

const EXACT = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

/** "Nov 27, 2026, 2:05 PM" in the viewer's time zone, or "" for an unreadable time. */
export function exactTimeLabel(at: string): string {
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? EXACT.format(ms) : "";
}
