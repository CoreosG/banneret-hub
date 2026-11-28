// The lease protocol on a work tracker (docs/banneret/relay-v1/README.md, "Lease protocol"): the `claim:` and
// `release:` comment lines, the labels `claimed` and `paused`, and the fold that turns an issue's comments,
// assignees and labels into who holds it. Pure and dependency free: the Hub server, the fake relay and the
// fold fixtures in docs/banneret/relay-v1/fixtures/lease-fold/ all run this one copy.

/** Reasons a person picks when releasing a task. Matched exactly; anything else reads as `other`. */
export const LEASE_RELEASE_REASONS = [
  "done",
  "blocked",
  "handing_over",
  "out_of_usage",
  "wrong_approach",
  "duplicate",
  "deprioritised",
  "other",
] as const;
export type LeaseReleaseReason = (typeof LEASE_RELEASE_REASONS)[number];

/**
 * Written only by the Hub itself, never offered to a person. In a comment they withdraw the author's own claim;
 * they are never a release reason, so they never reach `lastRelease` or the feed.
 */
const LEASE_SYSTEM_REASONS = ["lost_claim", "take_failed"] as const;
export type LeaseSystemReason = (typeof LEASE_SYSTEM_REASONS)[number];

/**
 * The agent tools the Hub serves over MCP (docs/banneret/agents.md). A relay enables each one by naming it in
 * its capabilities `mcpTools`; the Hub keeps its own description and schema.
 */
export const BANNERET_CHAT_TOOLS = [
  "banneret_chat_read",
  "banneret_chat_search",
  "banneret_chat_post",
  "banneret_chat_reply",
  "banneret_chat_progress",
  "banneret_handoff_offer",
  "banneret_chat_ask",
  "banneret_agent_ask",
  "banneret_agent_answer",
  "banneret_chat_inbox",
] as const;
export const BANNERET_POOL_TOOLS = [
  "banneret_pool_status",
  "banneret_sandbox_request",
  "banneret_sandbox_status",
  "banneret_sandbox_cancel",
] as const;
export const BANNERET_AGENT_TOOLS = [
  ...BANNERET_CHAT_TOOLS,
  ...BANNERET_POOL_TOOLS,
  "banneret_board",
  "banneret_needs",
  "banneret_task",
  "banneret_lease_check",
  "banneret_lease_take",
  "banneret_lease_release",
  "banneret_lease_withdraw",
  "banneret_team",
] as const;
export type BanneretAgentToolName = (typeof BANNERET_AGENT_TOOLS)[number];

export const LEASE_LABEL_CLAIMED = "claimed";
/** How long tracker state may disagree with the comments before the lease reads as `incomplete`. */
const LEASE_SETTLE_MS = 60_000;
/** The note after line 1 of a release, in UTF-8 bytes. */
export const LEASE_NOTE_MAX_BYTES = 2_048;
/** `reasonText`, in characters (Unicode code points). */
export const LEASE_REASON_TEXT_MAX = 200;
const LEASE_FREE_TO_CONTINUE = "free to continue";
const SEPARATOR = " · ";

export interface LeaseComment {
  /**
   * The tracker's comment id. On GitHub this is the numeric REST id (`databaseId`, the number in
   * `#issuecomment-<id>`), never the GraphQL node id, so every reader breaks a same-second tie the same way.
   */
  readonly id: string;
  /** The author's login, or null for a deleted account. */
  readonly author: string | null;
  readonly createdAt: string;
  /**
   * When the comment was last edited (equal to `createdAt` when it never was). A `claim:` or `release:` comment
   * edited after it was written is ignored: anyone with write access can edit another person's comment.
   */
  readonly updatedAt: string;
  readonly body: string;
}

export interface LeaseFoldInput {
  readonly comments: ReadonlyArray<LeaseComment>;
  /** Logins assigned now. */
  readonly assignees: ReadonlyArray<string>;
  /** Label names on the issue now. */
  readonly labels: ReadonlyArray<string>;
  /** Logins holding the founder role; their release frees someone else's lease. */
  readonly founders: ReadonlyArray<string>;
  readonly now: string;
}

/** `active` and `conflict` follow the comments; the relay ages `active` into `stale` and `expired`. */
export type LeaseFoldState = "active" | "conflict" | "incomplete";

export interface LeaseFoldLease {
  readonly holder: string;
  readonly state: LeaseFoldState;
  /** When the holder's claim was posted; null when no claim comment backs the lease (a leftover assignee). */
  readonly since: string | null;
  /** Logins of every standing claim, earliest first. The holder is first; more than one is a conflict. */
  readonly claimants: ReadonlyArray<string>;
}

/** One counted release, in comment order: what the feed's `released` entries are made from. */
export interface LeaseRelease {
  readonly by: string;
  /** Whose claim it ended. Differs from `by` only for a founder release. */
  readonly holder: string;
  readonly at: string;
  readonly reason: LeaseReleaseReason;
  /** As written on line 1. */
  readonly freeToContinue: boolean;
  readonly reasonText?: string;
  readonly note?: string;
}

export interface LeaseLastRelease {
  readonly by: string;
  readonly at: string;
  readonly reason: LeaseReleaseReason;
  /** Written as free to continue, and nobody is assigned now. */
  readonly freeToContinue: boolean;
  readonly reasonText?: string;
  readonly note?: string;
}

export interface LeaseFoldResult {
  readonly sandboxAgent?: string;
  /** Null means free. */
  readonly lease: LeaseFoldLease | null;
  /** The latest counted release, while no claim stands. A withdrawn claim does not hide it. */
  readonly lastRelease: LeaseLastRelease | null;
  readonly releases: ReadonlyArray<LeaseRelease>;
}

export type LeaseLine =
  | { readonly kind: "claim"; readonly login: string; readonly agent?: string }
  | {
      readonly kind: "release";
      readonly reason: LeaseReleaseReason;
      readonly freeToContinue: boolean;
      readonly reasonText?: string;
      readonly note?: string;
    }
  | { readonly kind: "withdraw"; readonly reason: LeaseSystemReason };

const LOGIN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const AGENT = /^[A-Za-z0-9._-]{1,64}$/;
// Control characters other than tab and newline never survive into text a client shows.
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const isReleaseReason = (value: string): value is LeaseReleaseReason =>
  (LEASE_RELEASE_REASONS as ReadonlyArray<string>).includes(value);
const isSystemReason = (value: string): value is LeaseSystemReason =>
  (LEASE_SYSTEM_REASONS as ReadonlyArray<string>).includes(value);

const clean = (text: string) => text.replace(/\r/g, "").replace(CONTROL, "");

/** At most `max` code points. */
export const capCodePoints = (text: string, max: number): string => {
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(0, max).join("");
};

export const utf8Length = (text: string): number => new TextEncoder().encode(text).length;

/** At most `max` UTF-8 bytes, cut on a code point. */
export const capUtf8 = (text: string, max: number): string => {
  if (utf8Length(text) <= max) return text;
  let out = "";
  let used = 0;
  for (const point of text) {
    const size = utf8Length(point);
    if (used + size > max) break;
    out += point;
    used += size;
  }
  return out;
};

/**
 * Reads line 1 of a comment. Returns null for a comment that is not part of the protocol. A claim's login is
 * returned as written; the fold checks it against the comment's author.
 */
export const parseLeaseLine = (body: string): LeaseLine | null => {
  const text = clean(body);
  const newline = text.indexOf("\n");
  const first = (newline < 0 ? text : text.slice(0, newline)).trim();
  if (first.startsWith("claim:")) {
    const rest = first.slice("claim:".length).trim();
    const slash = rest.indexOf("/");
    const login = slash < 0 ? rest : rest.slice(0, slash);
    const agent = slash < 0 ? undefined : rest.slice(slash + 1);
    if (!LOGIN.test(login)) return null;
    if (agent !== undefined && !AGENT.test(agent)) return null;
    return agent === undefined ? { kind: "claim", login } : { kind: "claim", login, agent };
  }
  if (!first.startsWith("release:")) return null;
  let rest = first.slice("release:".length).trim();
  let freeToContinue = false;
  const suffix = /(?:^|\s*·\s*)free to continue$/i;
  if (suffix.test(rest)) {
    freeToContinue = true;
    rest = rest.replace(suffix, "").trim();
  }
  const dot = rest.indexOf("·");
  const token = (dot < 0 ? rest : rest.slice(0, dot)).trim();
  const extra = dot < 0 ? "" : rest.slice(dot + 1).trim();
  if (isSystemReason(token)) return { kind: "withdraw", reason: token };
  const known = isReleaseReason(token);
  const rawText = known ? extra : rest;
  const reasonText = capCodePoints(rawText.replace(/\s+/g, " ").trim(), LEASE_REASON_TEXT_MAX);
  const note =
    newline < 0 ? "" : capUtf8(text.slice(newline + 1).trim(), LEASE_NOTE_MAX_BYTES).trim();
  return {
    kind: "release",
    reason: known ? token : "other",
    freeToContinue,
    ...(reasonText === "" ? {} : { reasonText }),
    ...(note === "" ? {} : { note }),
  };
};

export const formatClaimLine = (login: string, agent: string): string => `claim: ${login}/${agent}`;

export const formatWithdrawLine = (reason: LeaseSystemReason, text?: string): string =>
  text === undefined || text === ""
    ? `release: ${reason}`
    : `release: ${reason}${SEPARATOR}${text}`;

export interface ReleaseCommentInput {
  readonly reason: LeaseReleaseReason;
  /** Required for `other`; one line. */
  readonly reasonText?: string | undefined;
  readonly freeToContinue: boolean;
  readonly note?: string | undefined;
  /** Issue keys of follow-up work, as the tracker writes them (`#51`). */
  readonly followUps?: ReadonlyArray<string> | undefined;
}

/** Why a release comment cannot be written as asked, or null when it can. */
export const checkReleaseComment = (input: ReleaseCommentInput): string | null => {
  if (!isReleaseReason(input.reason)) return `Unknown release reason "${input.reason}".`;
  const text = input.reasonText?.trim() ?? "";
  if (input.reason === "other" && text === "") return "Say why when the reason is Other.";
  if (/[\r\n]/.test(text)) return "The reason text must be one line.";
  if (Array.from(text).length > LEASE_REASON_TEXT_MAX)
    return `The reason text is longer than ${LEASE_REASON_TEXT_MAX} characters.`;
  if (/free to continue$/i.test(text)) return 'The reason text cannot end with "free to continue".';
  const note = releaseNote(input);
  if (utf8Length(note) > LEASE_NOTE_MAX_BYTES)
    return `The note is longer than ${LEASE_NOTE_MAX_BYTES} bytes.`;
  if (input.followUps?.some((key) => !/^[A-Za-z0-9#._/-]{1,100}$/.test(key)) === true)
    return "A follow-up must be an issue key such as #51.";
  return null;
};

const releaseNote = (input: ReleaseCommentInput) => {
  const note = clean(input.note ?? "").trim();
  const followUps =
    input.followUps === undefined || input.followUps.length === 0
      ? ""
      : `Follow-ups: ${input.followUps.join(", ")}`;
  return [note, followUps].filter((part) => part !== "").join("\n");
};

/** Line 1, then the note. Call `checkReleaseComment` first. */
export const formatReleaseComment = (input: ReleaseCommentInput): string => {
  const text = input.reasonText?.trim() ?? "";
  const line =
    `release: ${input.reason}` +
    (text === "" ? "" : `${SEPARATOR}${text}`) +
    (input.freeToContinue ? `${SEPARATOR}${LEASE_FREE_TO_CONTINUE}` : "");
  const note = releaseNote(input);
  return note === "" ? line : `${line}\n${note}`;
};

const compareIds = (a: string, b: string) => {
  const numeric = /^\d+$/;
  if (numeric.test(a) && numeric.test(b)) {
    const left = a.replace(/^0+(?=\d)/, "");
    const right = b.replace(/^0+(?=\d)/, "");
    if (left.length !== right.length) return left.length - right.length;
  }
  return a < b ? -1 : a > b ? 1 : 0;
};

/** Comment order: `createdAt`, then the comment id. */
const compareLeaseComments = (a: LeaseComment, b: LeaseComment): number =>
  Date.parse(a.createdAt) - Date.parse(b.createdAt) || compareIds(a.id, b.id);

interface Claim {
  readonly agent?: string;
  readonly login: string;
  readonly at: string;
}

/**
 * The fold (README, "Lease protocol"): the holder is the earliest standing claim, ordered by `createdAt` then
 * comment id; an edited claim or release is ignored; a counted release or the author's withdrawal ends a claim; more than one standing claim is a conflict.
 */
export const foldLease = (
  input: LeaseFoldInput,
  onTransition?: (comment: LeaseComment, holder: string, release?: LeaseRelease) => void,
): LeaseFoldResult => {
  const comments = input.comments
    .map((comment, index) => ({ comment, index }))
    .sort((a, b) => compareLeaseComments(a.comment, b.comment) || a.index - b.index)
    .map(({ comment }) => comment);
  const standing: Claim[] = [];
  const releases: LeaseRelease[] = [];
  let lastEventAt: string | null = null;
  let lastRelease: { release: LeaseRelease; holderSince: string } | null = null;
  // Logins whose claim ended by a counted release or a withdrawal: evidence the protocol was used for them.
  const ended: string[] = [];

  const indexOf = (login: string) => standing.findIndex((claim) => same(claim.login, login));
  for (const comment of comments) {
    if (comment.author === null) continue;
    const author = comment.author;
    const line = parseLeaseLine(comment.body);
    if (line === null) continue;
    // An edited protocol comment may not say what its author wrote, so it counts for nothing.
    if (Date.parse(comment.updatedAt) > Date.parse(comment.createdAt)) continue;
    if (line.kind === "claim") {
      if (!same(line.login, author) || indexOf(author) >= 0) continue;
      if (!standing.length) onTransition?.(comment, author);
      standing.push({
        login: author,
        at: comment.createdAt,
        ...(line.agent && { agent: line.agent }),
      });
      lastEventAt = comment.createdAt;
      continue;
    }
    const own = indexOf(author);
    if (line.kind === "withdraw" || (own > 0 && line.kind === "release")) {
      if (own < 0) continue;
      ended.push(author);
      standing.splice(own, 1);
      lastEventAt = comment.createdAt;
      continue;
    }
    const holder = standing[0];
    if (holder === undefined) continue;
    const founder = input.founders.some((login) => same(login, author));
    if (own !== 0 && !founder) continue;
    standing.shift();
    ended.push(holder.login);
    const release: LeaseRelease = {
      by: author,
      holder: holder.login,
      at: comment.createdAt,
      reason: line.reason,
      freeToContinue: line.freeToContinue,
      ...(line.reasonText === undefined ? {} : { reasonText: line.reasonText }),
      ...(line.note === undefined ? {} : { note: line.note }),
    };
    onTransition?.(comment, holder.login, release);
    releases.push(release);
    lastRelease = { release, holderSince: holder.at };
    lastEventAt = comment.createdAt;
  }

  const now = Date.parse(input.now);
  const settled = (at: string | null) => at === null || now - Date.parse(at) >= LEASE_SETTLE_MS;
  const assigned = (login: string) => input.assignees.some((name) => same(name, login));
  const claimedLabel = input.labels.some((name) => same(name, LEASE_LABEL_CLAIMED));

  let lease: LeaseFoldLease | null = null;
  const first = standing[0];
  if (first !== undefined) {
    const claimants = standing.map((claim) => claim.login);
    const agrees = assigned(first.login) && claimedLabel;
    lease = {
      holder: first.login,
      state:
        standing.length > 1 ? "conflict" : agrees || !settled(first.at) ? "active" : "incomplete",
      since: first.at,
      claimants,
    };
  } else {
    // No claim stands. The tracker still shows the protocol only when a release or withdrawal is unfinished
    // (the ended claimant is still assigned) or the `claimed` label is left behind. A plain assignee with
    // neither is an assignment made outside the protocol: not a lease.
    const released = lastRelease?.release.holder ?? null;
    const endedAssignee = input.assignees.find((name) => ended.some((login) => same(login, name)));
    const residue =
      released !== null && assigned(released)
        ? released
        : (endedAssignee ?? (claimedLabel ? (input.assignees[0] ?? released) : null));
    if (residue !== null && settled(lastEventAt)) {
      lease = {
        holder: residue,
        state: "incomplete",
        since:
          released !== null && same(residue, released) ? (lastRelease?.holderSince ?? null) : null,
        claimants: [],
      };
    }
  }

  return {
    ...(first?.agent?.startsWith("sandbox-") && { sandboxAgent: first.agent }),
    lease,
    lastRelease:
      first !== undefined || lastRelease === null
        ? null
        : {
            by: lastRelease.release.by,
            at: lastRelease.release.at,
            reason: lastRelease.release.reason,
            freeToContinue: lastRelease.release.freeToContinue && input.assignees.length === 0,
            ...(lastRelease.release.reasonText === undefined
              ? {}
              : { reasonText: lastRelease.release.reasonText }),
            ...(lastRelease.release.note === undefined ? {} : { note: lastRelease.release.note }),
          },
    releases,
  };
};
