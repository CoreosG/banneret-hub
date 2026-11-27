// Banneret Hub: what the Enterprise screens say for each enrolment state. Pure, so every state and
// reason string is unit-tested in one place. Relay strings are only ever rendered as text.
import {
  BANNERET_MACHINE_LABEL_PATTERN,
  type BanneretEnrolmentMachine,
  type BanneretEnrolmentView,
  type BanneretWorkspace,
} from "@t3tools/contracts";

import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import type { Project } from "../types";

export function peerUpdateMessage(version: string | undefined, missingRpc: boolean) {
  const older = version && parseSemver(version) && compareSemverVersions(version, "0.1.1224") < 0;
  if (!older && !missingRpc) return null;
  return "Update needed to read its status" + (version ? ` (v${version.replace(/^v/, "")})` : "");
}

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
      return canJoinAgain(view) ? "address" : "connected";
    case "revoked":
      return "revoked";
    default:
      return "address";
  }
}

/** Why the last enrolment ended (state `none`), in plain words. */
export function lastResultMessage(view: BanneretEnrolmentView | null): string | null {
  if (view === null || view.state !== "none" || view.reason === undefined) return null;
  const account = `Relay sign-in: ${view.refusedLogin ?? "Not available"}.`;
  switch (view.reason) {
    case "cancelled":
      return "Joining was cancelled.";
    case "declined":
      return `A founder declined this machine. ${account}`;
    case "not_org_member":
      return `The account is not an organization member. ${account}`;
    case "not_staff":
      return `That account is not on the company's staff list. ${account}`;
    case "network_identity_mismatch":
      return `The sign-in did not come from your registered network. ${account}`;
    case "environment_enrolled":
      return `Another person has already joined this machine. They must remove it first. ${account}`;
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
    case "unknown_machine":
      return view.message ?? unknownMachineText(undefined);
    case "forgotten":
      return "This machine was forgotten here. A founder must still remove it on the relay.";
    default:
      return view.message ?? "Joining did not finish. Try again.";
  }
}

const unknownMachineText = (displayName: string | undefined) =>
  `${displayName ?? "The company"} no longer knows this machine (the relay may have been reset). Join again.`;

/** Why the wizard offers to join again, for a configured machine the relay refused. */
export function joinAgainNotice(view: BanneretEnrolmentView): string {
  return view.health === "unknown_machine"
    ? unknownMachineText(view.displayName)
    : `The relay refused this machine. Join again to replace it. Relay account: ${view.me?.login ?? "Not available"}.`;
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

/** A pending join's line with its code, so the person can tell two pending joins apart. */
const withCode = (text: string, view: BanneretEnrolmentView) =>
  view.confirmCode === undefined ? text : `${text} \u00b7 code ${view.confirmCode}`;

export const machineEnrolment = {
  unknown: "Status unavailable",
  none: "Not joined",
  requested: "Pending",
  awaiting_approval: "Pending",
  approved: "Pending",
  configured: "Joined",
  revoked: "Revoked",
} as const;

/**
 * Joins still in progress whose workspace does not exist yet (the server writes it once the join
 * completes). The switcher lists each, so starting a second join never hides the first.
 */
export function pendingJoins(
  views: ReadonlyArray<BanneretEnrolmentView>,
  workspaces: ReadonlyArray<BanneretWorkspace>,
): ReadonlyArray<BanneretEnrolmentView> {
  const live = new Set(
    workspaces.filter((entry) => entry.deleted !== true).map((entry) => entry.id),
  );
  return views.filter(
    (view) => machineEnrolment[view.state] === "Pending" && !live.has(view.workspaceId),
  );
}

/** What "Copy details" puts on the clipboard: the facts support matches to `pairings list`. */
export function joinDetails(
  view: BanneretEnrolmentView,
  machine: BanneretEnrolmentMachine | null,
): string {
  return [
    `Relay: ${view.relayOrigin}`,
    view.pairingId === undefined ? null : `Pairing: ${view.pairingId}`,
    machine === null || machine.environmentId === ""
      ? null
      : `Environment: ${machine.environmentId}`,
    machine === null ? null : `Hostname: ${machine.hostname}`,
    machine === null ? null : `Hub version: ${machine.hubVersion}`,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/** The status line under an Enterprise workspace in the switcher, for this machine. */
export function enrolmentLine(
  workspace: BanneretWorkspace,
  view: BanneretEnrolmentView | null,
): EnrolmentLine {
  return view === null || view.workspaceId !== workspace.id
    ? { tone: "muted", text: "Not joined on this machine · Join" }
    : joinLine(view);
}

/** Where this machine's join with one relay stands, in the switcher's words. */
export function joinLine(view: BanneretEnrolmentView): EnrolmentLine {
  switch (view.state) {
    case "none":
      return { tone: "muted", text: "Not joined on this machine · Join" };
    case "requested":
      return { tone: "warn", text: withCode("Waiting for sign-in", view) };
    case "awaiting_approval":
      return { tone: "warn", text: withCode("Waiting for a founder to approve", view) };
    case "approved":
      return view.health === undefined
        ? { tone: "muted", text: "Finishing setup…" }
        : healthLine(view);
    case "revoked":
      return { tone: "error", text: revokedMessage(view) };
    case "configured":
      return healthLine(view);
  }
}

/** The line for the run-time health of an approved or configured enrolment. */
export function healthLine(view: BanneretEnrolmentView): EnrolmentLine {
  switch (view.health) {
    case "healthy":
      return { tone: "ok", text: connectedLine(view.me) };
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
      return {
        tone: "error",
        text: `The relay refused this machine. Relay account: ${view.me?.login ?? "Not available"}.`,
      };
    case "unknown_machine":
      return { tone: "error", text: unknownMachineText(view.displayName) };
    case "forbidden":
      return {
        tone: "error",
        text: `The relay does not allow this machine. Relay account: ${view.me?.login ?? "Not available"}.`,
      };
    case "invalid_reply":
      return { tone: "error", text: "The relay's answers do not match this version" };
    default:
      return { tone: "muted", text: "Checking the connection…" };
  }
}

/** Leave without telling the relay is offered only while the relay cannot confirm. */
export function canForget(view: BanneretEnrolmentView | null): boolean {
  return (
    (view?.state === "configured" || view?.state === "approved") &&
    view.health !== undefined &&
    view.health !== "healthy"
  );
}

/** A machine the relay refused (401) may join again, replacing its key and token. */
export function canJoinAgain(view: BanneretEnrolmentView | null): boolean {
  return (
    view?.state === "configured" && (view.health === "refused" || view.health === "unknown_machine")
  );
}

/** Why Leave may not reach the relay, and what forgetting here means; null while healthy. */
export function forgetNotice(view: BanneretEnrolmentView | null): string | null {
  if (!canForget(view)) return null;
  const then =
    "You can forget this machine here instead; a founder must then remove it on the relay.";
  switch (view?.health) {
    case "refused":
      return `The relay refused this machine, so it cannot confirm that it left. Relay account: ${view.me?.login ?? "Not available"}. ${then}`;
    case "unknown_machine":
      return `${view.displayName ?? "The company"} no longer knows this machine (the relay may have been reset), so it cannot confirm that it left. Relay account: ${view.me?.login ?? "Not available"}. ${then}`;
    case "forbidden":
      return `The relay does not allow this machine to remove itself. Relay account: ${view.me?.login ?? "Not available"}. ${then}`;
    case "clock_wrong":
      return `This machine's clock is wrong, so the relay would reject its calls. Fix the clock and try again, or forget it. ${then}`;
    case "invalid_reply":
      return `The relay's answers do not match this version of Banneret Hub. ${then}`;
    default:
      return `The relay cannot be reached. ${then}`;
  }
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

/** A login from the relay, trimmed; empty when the relay sent none. */
export function cleanLogin(login: string | undefined): string {
  return login?.trim() ?? "";
}

/** A login for a column of people; "Unknown" when the relay sent none. */
export function loginOrUnknown(login: string | undefined): string {
  return cleanLogin(login) || "Unknown";
}

/** " · <label> <login>" or nothing when the login is empty; never a dangling separator. */
export function loginSuffix(label: string, login: string | undefined): string {
  const clean = cleanLogin(login);
  return clean === "" ? "" : ` \u00b7 ${label} ${clean}`;
}

/** "Signed in as ada · Founder"; drops the login or the role when the relay sent none. */
export function connectedLine(
  me: { login?: string | undefined; role?: string | undefined } | undefined,
): string {
  const login = cleanLogin(me?.login);
  const role = me?.role?.trim() ? roleLabel(me.role) : "";
  const head = login === "" ? "Connected" : `Signed in as ${login}`;
  return role === "" ? head : `${head} \u00b7 ${role}`;
}

const KNOWN_NEEDS_KINDS: Readonly<Record<string, string>> = {
  thread_question: "Question from an agent",
  pr_approval: "You can approve",
  waiting_for_approver: "Waiting for an approver",
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
  "chat",
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
