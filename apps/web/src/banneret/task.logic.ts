// Banneret Hub: plain words for the Task tab (relay-v1 "Task" and "Checked"). The relay computes the
// status, the preview and whether a sign-off counts; these only name them. Every set is open.
import type { BanneretBoardCard, BanneretTaskChecked } from "@t3tools/contracts";

const TRACKER_NAMES: Readonly<Record<string, string>> = {
  github: "GitHub",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
  forgejo: "Forgejo",
  "azure-devops": "Azure DevOps",
  linear: "Linear",
  jira: "Jira",
};

/** The tracker's name for a link out; an unknown kind prints as the relay named it. */
export const trackerName = (tracker: string) => TRACKER_NAMES[tracker] ?? tracker;

const PREVIEW_STATES: Readonly<Record<string, string>> = {
  building: "building",
  ready: "ready",
  failed: "failed",
};

export const previewStateLabel = (state: string) =>
  PREVIEW_STATES[state] ?? state.replaceAll("_", " ");

export type CheckedView =
  | { readonly kind: "none" }
  | { readonly kind: "valid"; readonly by: string; readonly at: string }
  | { readonly kind: "ignored"; readonly by: string; readonly reason: string };

/** A valid sign-off shows who and when; an ignored one shows why it does not count. */
export function checkedView(checked: BanneretTaskChecked | undefined): CheckedView {
  if (checked === undefined) return { kind: "none" };
  const by = checked.by.login.trim();
  if (checked.valid) return { kind: "valid", by, at: checked.at };
  return {
    kind: "ignored",
    by,
    reason: checked.ignoredReason?.trim() || "It does not meet the sign-off rule.",
  };
}

export interface RestsOnItem {
  readonly id: string;
  /** The title when the board holds that task; otherwise only its id is known. */
  readonly title: string | null;
}

/** What a task rests on, with titles from the board where it holds them. */
export function restsOnItems(
  restsOn: ReadonlyArray<string>,
  cards: ReadonlyArray<BanneretBoardCard>,
): ReadonlyArray<RestsOnItem> {
  const titles = new Map(cards.map((card) => [card.task.id, card.task.title]));
  return restsOn.map((id) => ({ id, title: titles.get(id) ?? null }));
}
