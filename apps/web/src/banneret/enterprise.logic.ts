// Banneret Hub: what the Enterprise screens say for each enrolment state. Pure, so every state and
// reason string is unit-tested in one place. Relay strings are only ever rendered as text.
import {
  BANNERET_MACHINE_LABEL_PATTERN,
  type BanneretEnrolmentView,
  type BanneretWorkspace,
} from "@t3tools/contracts";

import type { Project } from "../types";

export type EnrolmentTone = "ok" | "warn" | "error" | "muted";

export interface EnrolmentLine {
  readonly tone: EnrolmentTone;
  readonly text: string;
}

/** The wizard screen for a view. A machine the relay refused (401) may join again. */
export type WizardStep = "address" | "code" | "awaiting" | "finishing" | "connected" | "revoked";

export function wizardStep(view: BanneretEnrolmentView | null): WizardStep {
  switch (view?.state) {
    case "requested":
      return "code";
    case "awaiting_approval":
      return "awaiting";
    case "approved":
      return "finishing";
    case "configured":
      return view.health === "refused" ? "address" : "connected";
    case "revoked":
      return "revoked";
    default:
      return "address";
  }
}

/** Why the last enrolment ended (state `none`), in plain words. */
export function lastResultMessage(view: BanneretEnrolmentView | null): string | null {
  if (view === null || view.state !== "none" || view.reason === undefined) return null;
  switch (view.reason) {
    case "cancelled":
      return "Joining was cancelled.";
    case "declined":
      return "A founder declined this machine.";
    case "not_staff":
      return "That account is not on the company's staff list.";
    case "network_identity_mismatch":
      return "The sign-in did not come from your registered network.";
    case "environment_enrolled":
      return "Another person has already joined this machine. They must remove it first.";
    case "code_expired":
      return "The code expired before it was confirmed. Join again.";
    case "too_many_attempts":
      return "Too many wrong codes were typed. Join again.";
    case "approval_expired":
      return "No founder approved this machine within 7 days. Join again.";
    case "not_found":
      return "The relay no longer knows this request. Join again.";
    case "token_lost":
      return "Approved, but this Hub lost the token. Join again.";
    case "key_lost":
      return "This Hub lost its machine key. Join again.";
    case "left":
      return "You left the company. This machine is no longer joined.";
    case "forgotten":
      return "This machine was forgotten here. A founder must still remove it on the relay.";
    default:
      return view.message ?? "Joining did not finish. Try again.";
  }
}

export function revokedMessage(view: BanneretEnrolmentView): string {
  return view.reason === "replaced"
    ? "This machine was replaced by a newer enrolment"
    : `This machine was removed from ${view.displayName ?? "the company"}`;
}

const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const relayHost = (origin: string | undefined) => {
  if (origin === undefined) return "the relay";
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

/** The status line under an Enterprise workspace in the switcher, for this machine. */
export function enrolmentLine(
  workspace: BanneretWorkspace,
  view: BanneretEnrolmentView | null,
): EnrolmentLine {
  if (view === null || view.workspaceId !== workspace.id || view.state === "none") {
    return { tone: "muted", text: "Not joined on this machine · Join" };
  }
  switch (view.state) {
    case "requested":
      return { tone: "warn", text: "Waiting for sign-in" };
    case "awaiting_approval":
      return { tone: "warn", text: "Waiting for a founder to approve" };
    case "approved":
      return { tone: "muted", text: "Finishing setup…" };
    case "revoked":
      return { tone: "error", text: revokedMessage(view) };
    case "configured":
      switch (view.health) {
        case "healthy":
          return { tone: "ok", text: `Connected as ${view.me?.login ?? "you"}` };
        case "unreachable":
          return {
            tone: "warn",
            text: `Cannot reach ${relayHost(view.relayOrigin)}${
              view.unreachableSince ? ` since ${timeOf(view.unreachableSince)}` : ""
            }`,
          };
        case "clock_wrong":
          return { tone: "warn", text: "This machine's clock is wrong" };
        case "refused":
          return { tone: "error", text: "The relay refused this machine" };
        case "forbidden":
          return { tone: "error", text: "The relay does not allow this machine" };
        default:
          return { tone: "muted", text: "Checking the connection…" };
      }
  }
}

/** Leave without telling the relay is offered only while the relay cannot confirm. */
export function canForget(view: BanneretEnrolmentView | null): boolean {
  return view?.state === "configured" && view.health !== undefined && view.health !== "healthy";
}

/** Minutes and seconds left, "0:00" once past. */
export function countdown(expiresAt: string | undefined, nowMs: number): string {
  if (expiresAt === undefined) return "";
  const seconds = Math.max(0, Math.floor((Date.parse(expiresAt) - nowMs) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Relays name roles in an open set; anything unknown is limited staff. */
export function roleLabel(role: string): string {
  return role === "founder" ? "Founder" : "Staff";
}

const KNOWN_NEEDS_KINDS: Readonly<Record<string, string>> = {
  thread_question: "Question from an agent",
  thread_approval: "Approval for an agent",
  pull_request: "Pull request",
  promotion: "Promotion",
  founder_question: "Question for a founder",
  health: "Health",
  mention: "Mention",
  suggestion: "Suggestion",
};

/** A needs-you item kind; an unknown kind is a generic row, never an error. */
export function needsItemLabel(kind: string): {
  readonly label: string;
  readonly generic: boolean;
} {
  const label = KNOWN_NEEDS_KINDS[kind];
  return label === undefined ? { label: "Item", generic: true } : { label, generic: false };
}

const KNOWN_SECTION_KINDS = new Set([
  "today",
  "needs",
  "machines",
  "health",
  "board",
  "map",
  "feed",
  "task",
  "channel",
  "team",
  "knowledge",
]);

/** Sections render only by known kind; an unknown kind is skipped. */
export function isKnownSectionKind(kind: string): boolean {
  return KNOWN_SECTION_KINDS.has(kind);
}

/** One letter for the company avatar; the relay's iconUrl is never fetched. */
export function letterAvatar(displayName: string): string {
  const letter = [...displayName.trim()].find((character) => /\p{L}|\p{N}/u.test(character));
  return (letter ?? "?").toUpperCase();
}

/** A machine label the relay accepts, from a free-form name such as the environment's. */
export function machineLabelFrom(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9 ._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 64)
    .trim();
  return BANNERET_MACHINE_LABEL_PATTERN.test(cleaned) ? cleaned : "My machine";
}

export function isValidMachineLabel(label: string): boolean {
  return BANNERET_MACHINE_LABEL_PATTERN.test(label.trim());
}

/** The git remotes to match against the relay's list: only remotes, never folders. */
export function remoteUrlsOf(
  projects: ReadonlyArray<Pick<Project, "repositoryIdentity">>,
): string[] {
  return [
    ...new Set(
      projects.flatMap((project) =>
        project.repositoryIdentity ? [project.repositoryIdentity.locator.remoteUrl] : [],
      ),
    ),
  ];
}
