// Banneret Hub: plain words for the relay's Today and Needs you values. Every set the relay sends is
// open (relay-v1 "Versioning"), so each mapping has a generic fallback and never fails.
import type { BanneretFeedDeepLink } from "@t3tools/contracts";

const NEEDS_KINDS: Readonly<Record<string, string>> = {
  thread_question: "An agent asks you",
  thread_approval: "An agent needs your approval",
  pull_request: "Pull request",
  promotion: "Promotion",
  founder_question: "Question for a founder",
  health: "Health",
  mention: "Mention",
  agent_message: "Message from an agent",
  persona_ask: "A persona asks",
  suggestion: "Suggestion",
};

/** The label of a needs-you kind; `other` and unknown kinds share the generic one. */
export const needsKindLabel = (kind: string) => NEEDS_KINDS[kind] ?? "Item";

const SHIPPED_LIVE: Readonly<Record<string, string>> = {
  live: "live",
  not_live_yet: "merged, not live yet",
  deploy_failed: "merged, deploy failed",
  no_deploy: "merged",
};
export const shippedLabel = (live: string) => SHIPPED_LIVE[live] ?? "merged";

const WORKING_STATES: Readonly<Record<string, string>> = {
  working: "working",
  waiting: "waiting for you",
  idle: "idle",
  stopped: "stopped",
};
/** `not_heard_from` is told with its time by the caller (P2-6); unknown states say nothing. */
export const workingStateLabel = (state: string | undefined) =>
  state === undefined ? null : (WORKING_STATES[state] ?? null);

const STUCK_RULES: Readonly<Record<string, string>> = {
  claim_quiet: "No activity on a claimed task",
  check_failed: "Checks are failing",
  unreviewed: "Ready but not reviewed",
  checks_queued: "Checks are waiting to run",
  dev_red: "The development branch is failing",
  deploy_failed: "The latest preview deploy failed",
  watched_job_down: "A watched server job failed",
};
export const stuckRuleLabel = (rule: string) => STUCK_RULES[rule] ?? "Stuck";

const HEALTH_STATES: Readonly<Record<string, string>> = {
  good: "healthy",
  warning: "warning",
  bad: "failing",
  not_measured: "not measured",
};
export const healthStateLabel = (state: string) => HEALTH_STATES[state] ?? "unknown";

export type Tone = "ok" | "warn" | "error" | "muted";
const HEALTH_TONES: Readonly<Record<string, Tone>> = { good: "ok", warning: "warn", bad: "error" };
export const healthTone = (state: string): Tone => HEALTH_TONES[state] ?? "muted";

const NOT_MEASURED: Readonly<Record<string, string>> = {
  never_read: "not read yet",
  unreachable: "the source could not be reached",
  auth_failed: "sign-in to the source failed",
  permission_missing: "a permission is missing",
  rate_limited: "the source is rate limited",
  stale_publication: "the source is out of date",
  malformed: "the source's answer was unreadable",
  not_configured: "not set up on this relay",
  too_large: "the source's answer was too large",
};
export const notMeasuredReason = (reason: string) => NOT_MEASURED[reason] ?? "not measured";

/** A link out the page may render: http(s) only, so a `javascript:` url stays text. */
export function safeLinkOut(url: string | undefined): string | null {
  if (url === undefined) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

/** The sidebar count: the relay's own count when it sent one, else what is loaded. */
export function needsCountLabel(input: {
  readonly needsCount: number | null;
  readonly loaded: number | null;
  readonly more: boolean;
}): string | null {
  if (input.needsCount !== null) return input.needsCount > 99 ? "99+" : String(input.needsCount);
  if (input.loaded === null) return null;
  return input.more ? `${input.loaded}+` : String(input.loaded);
}

export type DeepLinkTarget =
  | { readonly kind: "thread"; readonly environmentId: string; readonly threadId: string }
  | { readonly kind: "link"; readonly url: string }
  | { readonly kind: "elsewhere"; readonly machine: string }
  | { readonly kind: "none" };

/**
 * Where an item opens: its thread when this client knows that environment and the thread, else its
 * link out, else which machine holds it.
 */
export function deepLinkTarget(input: {
  readonly deepLink: BanneretFeedDeepLink | undefined;
  readonly url: string | undefined;
  readonly environmentKnown: boolean;
  readonly threadKnown: boolean;
}): DeepLinkTarget {
  const { deepLink } = input;
  if (deepLink?.threadId !== undefined && input.environmentKnown && input.threadKnown) {
    return { kind: "thread", environmentId: deepLink.environmentId, threadId: deepLink.threadId };
  }
  const link = safeLinkOut(input.url);
  if (link !== null) return { kind: "link", url: link };
  if (deepLink !== undefined) {
    return { kind: "elsewhere", machine: deepLink.machineLabel ?? "another machine" };
  }
  return { kind: "none" };
}

/**
 * Whether to show a section: the relay advertises it, or its capabilities are not read yet (a relay
 * that is down when the Hub starts still shows the rows, with their last-known state).
 */
export const offersSection = (
  feed: { readonly sectionsKnown: boolean; readonly sections: ReadonlyArray<string> },
  kind: string,
) => !feed.sectionsKnown || feed.sections.includes(kind);
