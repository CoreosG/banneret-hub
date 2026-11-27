// Fork UI kit: words and tones for leases, stuck reasons and health. Each set is open; an unknown
// value keeps its own word in a neutral tone.
import { humanizeWord } from "./status";
import type { Tone } from "./tokens";

/**
 * Empty values in a facts grid use one of two words. "None" means the relay answered and there is
 * nothing (no pull request, no preview, nothing it rests on). "Not known" means the relay has not
 * said, or the task is not on the board. A row keeps its own words only when they carry meaning
 * beyond "nothing", such as "Still open" for Closed or "Not on the map" for Stage.
 */
export const EMPTY_NONE = "None";
export const EMPTY_NOT_KNOWN = "Not known";

export interface ToneLabel {
  readonly label: string;
  readonly tone: Tone;
}

// RelativeTime can describe an agent session or a work event. Never use it to show
// when a person was active. Claims and leases show state only, without ages.
export function leaseLabel(
  lease: { readonly state: string; readonly staleAt: string },
  nowMs: number,
): ToneLabel {
  switch (lease.state) {
    case "active":
      return nowMs < Date.parse(lease.staleAt)
        ? { label: "live", tone: "muted" }
        : { label: "quiet", tone: "warn" };
    case "stale":
      return { label: "quiet", tone: "warn" };
    case "expired":
      return { label: "expired, should be released", tone: "error" };
    case "paused":
      return { label: "paused", tone: "muted" };
    case "conflict":
      return { label: "conflict, two people claim this", tone: "error" };
    default:
      return { label: lease.state.replaceAll("_", " "), tone: "muted" };
  }
}

const REASONS: Readonly<Record<string, ToneLabel>> = {
  dev_red: { label: "Dev branch red", tone: "error" },
  check_failed: { label: "Checks failing", tone: "error" },
  deploy_failed: { label: "Deploy failed", tone: "error" },
  watched_job_down: { label: "Server job down", tone: "error" },
  unreviewed: { label: "Not reviewed", tone: "warn" },
  claim_quiet: { label: "Quiet claim", tone: "warn" },
  checks_queued: { label: "Checks queued", tone: "muted" },
};

export function reasonLabel(reason: string): ToneLabel {
  return REASONS[reason] ?? { label: humanizeWord(reason), tone: "muted" };
}

const HEALTH: Readonly<Record<string, ToneLabel>> = {
  good: { label: "Healthy", tone: "ok" },
  warning: { label: "Warning", tone: "warn" },
  bad: { label: "Failing", tone: "error" },
  not_measured: { label: "Not measured", tone: "muted" },
};

export function healthLabel(state: string): ToneLabel {
  return HEALTH[state] ?? { label: humanizeWord(state), tone: "muted" };
}
