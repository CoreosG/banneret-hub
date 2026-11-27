// Banneret Hub: words and rules for take and release (relay-v1 "Lease protocol"). The server's
// LeaseService decides what may run and writes to the tracker; these only name reasons, build the
// release form's note and say what happened in plain words.
import {
  checkReleaseComment,
  LEASE_NOTE_MAX_BYTES,
  LEASE_REASON_TEXT_MAX,
  utf8Length,
  type BanneretBoardCard,
  type BanneretLastRelease,
  type LeaseReleaseReason,
  type TaskLeaseResult,
  type TaskLeaseStatus,
} from "@t3tools/contracts";

import { humanizeWord } from "./ui/status";

/** The reasons a person picks, in the dialog's order. */
export const RELEASE_REASON_OPTIONS: ReadonlyArray<{
  readonly id: LeaseReleaseReason;
  readonly label: string;
}> = [
  { id: "done", label: "Done" },
  { id: "blocked", label: "Blocked" },
  { id: "handing_over", label: "Handing over" },
  { id: "out_of_usage", label: "Out of usage" },
  { id: "wrong_approach", label: "Wrong approach" },
  { id: "duplicate", label: "Duplicate" },
  { id: "deprioritised", label: "Deprioritised" },
  { id: "other", label: "Other" },
];

const REASON_LABELS = new Map<string, string>(
  RELEASE_REASON_OPTIONS.map((option) => [option.id, option.label]),
);

/** An unknown reason from the relay keeps its own words. */
const releaseReasonLabel = (reason: string): string =>
  REASON_LABELS.get(reason) ?? humanizeWord(reason);

/** "Free to continue" starts on for reasons that leave work someone else can pick up. */
const freeToContinueByDefault = (reason: LeaseReleaseReason): boolean =>
  reason === "handing_over" || reason === "out_of_usage" || reason === "blocked";

export interface ReleaseForm {
  readonly reason: LeaseReleaseReason | null;
  readonly otherText: string;
  readonly goal: string;
  readonly done: string;
  readonly next: string;
  readonly freeToContinue: boolean;
}

export const emptyReleaseForm: ReleaseForm = {
  reason: null,
  otherText: "",
  goal: "",
  done: "",
  next: "",
  freeToContinue: false,
};

/** Choosing a reason resets the toggle to that reason's default. */
export const chooseReason = (form: ReleaseForm, reason: LeaseReleaseReason): ReleaseForm => ({
  ...form,
  reason,
  freeToContinue: freeToContinueByDefault(reason),
});

/** Plain lines, no markup: the relay and the Hub show the note as written. */
function releaseNote(form: Pick<ReleaseForm, "goal" | "done" | "next">): string {
  return [
    ["Goal", form.goal],
    ["Done", form.done],
    ["Next", form.next],
  ]
    .map(([label, value]) => [label, (value ?? "").replace(/\s+/g, " ").trim()] as const)
    .filter(([, value]) => value !== "")
    .map(([label, value]) => `${label}: ${value}`)
    .join("\n");
}

export const otherTextLength = (text: string): number => Array.from(text).length;
export const noteBytes = (form: ReleaseForm): number => utf8Length(releaseNote(form));
export const NOTE_MAX_BYTES = LEASE_NOTE_MAX_BYTES;
export const OTHER_TEXT_MAX = LEASE_REASON_TEXT_MAX;

/** Why the form cannot be sent yet, or null. The server checks the same rules again. */
export function releaseFormProblem(form: ReleaseForm): string | null {
  if (form.reason === null) return "Pick a reason.";
  const note = releaseNote(form);
  return checkReleaseComment({
    reason: form.reason,
    reasonText: form.reason === "other" ? form.otherText : undefined,
    freeToContinue: form.freeToContinue,
    note: note === "" ? undefined : note,
  });
}

/** The release call's input, without the issue reference. */
export function releaseInput(form: ReleaseForm & { readonly reason: LeaseReleaseReason }) {
  const note = releaseNote(form);
  const text = form.otherText.trim();
  return {
    reason: form.reason,
    freeToContinue: form.freeToContinue,
    ...(form.reason === "other" && text !== "" ? { reasonText: text } : {}),
    ...(note === "" ? {} : { note }),
  };
}

/** One last release, from the board card or from the lease check (whose `by` is a login). */
export interface LastReleaseView {
  readonly by: string;
  readonly at: string;
  readonly reason: string;
  readonly freeToContinue: boolean;
  readonly reasonText?: string | undefined;
  readonly note?: string | undefined;
}

export function lastReleaseView(
  check: TaskLeaseStatus | null,
  card: BanneretLastRelease | undefined,
): LastReleaseView | null {
  if (check !== null) return check.lastRelease;
  if (card === undefined) return null;
  return { ...card, by: card.by.login };
}

/** "Out of usage", or "Other: not needed after the redesign". */
export function releaseReasonLine(release: Pick<LastReleaseView, "reason" | "reasonText">): string {
  const label = releaseReasonLabel(release.reason);
  return release.reasonText === undefined ? label : `${label}: ${release.reasonText}`;
}

/** "Free to continue · from ada · Out of usage" for a card the last holder left for others. */
export function freeToContinueLine(release: BanneretLastRelease): string {
  const from = release.by.login.trim();
  return [
    "Free to continue",
    ...(from === "" ? [] : [`from ${from}`]),
    releaseReasonLabel(release.reason),
  ].join(" · ");
}

export const isFreeToContinue = (card: Pick<BanneretBoardCard, "lease" | "lastRelease">) =>
  card.lease === undefined && card.lastRelease?.freeToContinue === true;

/** Free to continue cards first, each group in the relay's order. */
export function freeToContinueFirst(
  cards: ReadonlyArray<BanneretBoardCard>,
): ReadonlyArray<BanneretBoardCard> {
  return [...cards.filter(isFreeToContinue), ...cards.filter((card) => !isFreeToContinue(card))];
}

/** What a finished operation says. Null when the new status speaks for itself. */
export function outcomeMessage(result: TaskLeaseResult): string | null {
  if (result.detail !== undefined) return result.detail;
  switch (result.outcome) {
    case "taken":
      return "Taken by you.";
    case "released":
      return "Released.";
    case "withdrawn":
      return "Your claim is withdrawn.";
    case "lost": {
      const winner = result.status.lease?.holder;
      return winner === undefined ? "Someone else took it first." : `${winner} took it first.`;
    }
    case "incomplete":
      return "A step did not finish. Finish or Withdraw it.";
  }
}

/** The tone of a finished operation's message. */
export const outcomeTone = (result: TaskLeaseResult): "ok" | "warn" | "error" =>
  result.outcome === "taken" || result.outcome === "released" || result.outcome === "withdrawn"
    ? result.detail === undefined
      ? "ok"
      : "warn"
    : result.outcome === "lost"
      ? "warn"
      : "error";

/** The tag of a failed call's error, as the RPC layer hands it over. */
export interface LeaseCallFailure {
  readonly tag: string | null;
  readonly detail: string | null;
}

/** One plain sentence for a call that was refused or failed. The server's own words win. */
export function leaseFailureMessage(failure: LeaseCallFailure): string {
  switch (failure.tag) {
    case "TaskLeaseError":
      return failure.detail ?? "The tracker refused the change.";
    case "EnvironmentAuthorizationError":
      return "This device may not change tasks on this server. Ask its owner for operate access.";
    case "EnvironmentRpcUnavailableError":
      return "The Hub server is not reachable. Check the task before trying again.";
    default:
      return "The call failed. Check the task before trying again.";
  }
}
