// Fork UI kit: words and tones for leases, stuck reasons and health. Each set is open; an unknown
// value keeps its own word in a neutral tone.
import { humanizeWord } from "./status";
import { agoLabel, spanLabel } from "./relativeTime";
import type { Tone } from "./tokens";

export interface ToneLabel {
  readonly label: string;
  readonly tone: Tone;
}

/** The lease state words. Active is neutral (the icon is green); quiet warns; expired and conflict alarm. */
export function leaseLabel(
  lease: { readonly state: string; readonly lastSignalAt: string },
  nowMs: number,
): ToneLabel {
  switch (lease.state) {
    case "active":
      return {
        label: `active ${agoLabel(lease.lastSignalAt, nowMs)}`.trimEnd(),
        tone: "muted",
      };
    case "stale":
      return { label: `quiet ${spanLabel(lease.lastSignalAt, nowMs)}`.trimEnd(), tone: "warn" };
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
