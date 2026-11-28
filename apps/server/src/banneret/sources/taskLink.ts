// Banneret Hub: links a thread to the company task its agent claimed. Only the answer to an exact
// `<prefix>tasks_claim` or `<prefix>tasks_release` call on the company's server counts; text never links.
// The state is the thread's saved issue links and nothing else, so a restart changes nothing. The table is
// in docs/banneret/agents.md, and `transition` is its only writer.
import {
  IssueTrackerKind,
  threadIssueKeysEqual,
  type ThreadId,
  type ThreadIssueKey,
  type ThreadIssueLink,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import type { ThreadIssueService } from "../../orchestration-v2/ThreadIssueService.ts";
import type { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { linkTracker } from "../relay/Snapshot.ts";
import type { CompanySource } from "./ownership.ts";
import { readTask, type ProviderCard } from "./providerTasks.ts";
import { openSource } from "./sourceClient.ts";

export interface TaskLinkEvent {
  /** What the source answered: `claimed` and `released` move the link, anything else leaves it. */
  readonly status: unknown;
  readonly task: ThreadIssueKey;
}

/**
 * What changes for a thread with these links. A claim link is one an agent made on the same tracker; a
 * link a person made is never touched.
 */
export function transition(links: ReadonlyArray<ThreadIssueLink>, event: TaskLinkEvent) {
  const claimLinks = links.filter(
    (link) =>
      link.source === "agent" &&
      link.tracker === event.task.tracker &&
      link.host.toLowerCase() === event.task.host.toLowerCase(),
  );
  const same = (link: ThreadIssueLink) => threadIssueKeysEqual(link, event.task);
  if (event.status === "claimed")
    return {
      unlink: claimLinks.filter((link) => !same(link)),
      link: !links.some(same),
    };
  if (event.status === "released") return { unlink: claimLinks.filter(same), link: false };
  return { unlink: [], link: false };
}

/** `claim` or `release` when this is the source's own claim tool and the source owns tasks. */
export const claimVerb = (name: string, source: Pick<CompanySource, "prefix" | "owns">) =>
  !source.owns.includes("tasks")
    ? undefined
    : name === `${source.prefix}tasks_claim`
      ? ("claim" as const)
      : name === `${source.prefix}tasks_release`
        ? ("release" as const)
        : undefined;

const isTracker = Schema.is(IssueTrackerKind);
const httpUrl = (value: string) => {
  const url = URL.parse(value);
  return url && (url.protocol === "https:" || url.protocol === "http:") ? url : null;
};

/** The thread link for a task as its source read it; undefined when a thread cannot keep it. */
export function linkFor(card: ProviderCard) {
  const { ref, title } = card.task;
  const url = httpUrl(ref.url);
  const tracker = linkTracker(ref.tracker);
  const host = ref.host?.trim() || url?.host;
  const scope = ref.scope.trim();
  const key = ref.key.trim();
  if (!url || !isTracker(tracker) || !host || !scope || !key) return undefined;
  return {
    key: { tracker, host, scope, key },
    url: url.href,
    displayKey: key,
    title: title.replace(/\s+/g, " ").trim() || key,
  };
}

const locks = new Map<ThreadId, Semaphore.Semaphore>();
/** One change at a time for each thread, so two claim answers cannot both keep their link. */
const locked = (threadId: ThreadId) => {
  let lock = locks.get(threadId);
  if (!lock) locks.set(threadId, (lock = Semaphore.makeUnsafe(1)));
  return lock.withPermits(1);
};

/**
 * Applies a finished claim or release call to the thread. Returns the sentence to add to the tool's
 * answer when the thread could not follow it, so the failure shows in the chat. Never fails: the call at
 * the source already happened.
 */
export const followClaim = Effect.fn("BanneretTaskLink.follow")(function* (input: {
  readonly threadId: ThreadId;
  readonly relayOrigin: string;
  readonly source: CompanySource;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  /** The MCP result as the source sent it. */
  readonly result: unknown;
  readonly issues: Option.Option<ThreadIssueService["Service"]>;
  readonly threads: Pick<ThreadManagementService["Service"], "getThreadShell">;
}) {
  const { source, threadId } = input;
  const verb = claimVerb(input.tool, source);
  const result = input.result as {
    readonly isError?: unknown;
    readonly structuredContent?: { readonly status?: unknown } | null;
  } | null;
  if (!verb || !result || result.isError === true) return undefined;
  const status = result.structuredContent?.status;
  if (status !== (verb === "claim" ? "claimed" : "released")) return undefined;
  const missed = (why: string) =>
    `Banneret Hub did not ${verb === "claim" ? "link this chat to" : "unlink this chat from"} the ${source.title} task: ${why}`;
  const taskId = input.args.taskId;
  if (typeof taskId !== "string") return missed("the call named no task.");
  return yield* Effect.gen(function* () {
    if (Option.isNone(input.issues)) return missed("linking is not available on this server.");
    const issues = input.issues.value;
    // Read with the person's own sign-in: a task they cannot see is never linked.
    const session = yield* openSource(input.relayOrigin, source);
    const card = yield* readTask(session, taskId);
    if (!card) return missed(`${source.title} did not show the task.`);
    const task = linkFor(card);
    if (!task) return missed(`a chat cannot keep ${source.title}'s reference for it.`);
    return yield* locked(threadId)(
      Effect.gen(function* () {
        const thread = yield* input.threads.getThreadShell(threadId);
        if (!thread) return missed("the chat is gone.");
        const change = transition(thread.issues ?? [], { status, task: task.key });
        for (const link of change.unlink) yield* issues.unlink({ threadId, key: link });
        if (change.link)
          yield* issues.link({
            threadId,
            ref: { ...task.key, projectId: thread.projectId },
            url: task.url,
            displayKey: task.displayKey,
            title: task.title,
            source: "agent",
          });
        return undefined;
      }),
    );
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not follow a task claim", error).pipe(
        Effect.as(
          missed(
            error._tag === "SourceCallError" ? error.detail : "the chat could not be changed.",
          ),
        ),
      ),
    ),
  );
});
