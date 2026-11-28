import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { Button } from "../../components/ui/button";
import { matchesReview } from "./reviewPr";
import { askHome } from "./askHome";
import type { ReactNode } from "react";
import { useState } from "react";
import {
  ChatAsks,
  type BanneretBoardCard,
  ChatSettings,
  type ChatAsk,
  type ChannelAction,
  type BanneretFeedNeedsItem,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { RelayTarget } from "../enrolmentStore";
import { chatRpc, conversations, handles, members, pageItems, useChatRead } from "./client";

const decode = Schema.decodeUnknownSync(ChatAsks);
const plainReasons: Readonly<Record<string, string>> = {
  pr_gone:
    "The pull request is no longer on the board, so this review has ended. It may have been merged or closed.",
};
const settings = Schema.decodeUnknownSync(ChatSettings);
function CommitSha({ sha }: { sha: string }) {
  return (
    <Tooltip>
      <TooltipTrigger>
        <code>{sha.slice(0, 7)}</code>
      </TooltipTrigger>
      <TooltipPopup>{sha}</TooltipPopup>
    </Tooltip>
  );
}
export function AskCard({
  ask,
  names = new Map(),
  children,
  currentHead,
  viewer,
  postReview,
}: {
  ask: ChatAsk;
  names?: ReadonlyMap<string, string>;
  children?: ReactNode;
  currentHead?: string | undefined;
  viewer?: string | undefined;
  postReview?: (() => Promise<unknown>) | undefined;
}) {
  const [post, setPost] = useState("");
  const reviewed = ask.answer?.headSha;
  const stale = reviewed && currentHead && currentHead !== reviewed;
  if (ask.to.kind !== "agent") return null;
  const label = (id: string) => names.get(id) ?? id;
  const answer = ask.answer;
  return (
    <section className="my-2 grid gap-2 rounded-md border bg-card p-3">
      <header className="flex flex-wrap items-center gap-2">
        <strong>
          {label(ask.from.handle)} {ask.kind === "review" ? "requests a review from" : "asks"}{" "}
          {label(ask.to.handle)}
        </strong>
        <span className="ml-auto text-xs">{ask.state.replace("_", " ")}</span>
      </header>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        {ask.pr && (
          <>
            <dt>Pull request</dt>
            <dd>
              {ask.pr.repo}#{ask.pr.number} at <CommitSha sha={ask.pr.headSha} />
            </dd>
          </>
        )}
        <dt>{ask.kind === "review" ? "Review request" : "Question"}</dt>
        <dd>{ask.question}</dd>
        {ask.context && (
          <>
            <dt>Context</dt>
            <dd>{ask.context}</dd>
          </>
        )}
        {ask.doneWhen && (
          <>
            <dt>Answered when</dt>
            <dd>{ask.doneWhen}</dd>
          </>
        )}
        <dt>Asked for</dt>
        <dd>{ask.onBehalfOf.login}</dd>
        {ask.taskRef && (
          <>
            <dt>Task</dt>
            <dd>{ask.taskRef}</dd>
          </>
        )}
      </dl>
      <small>
        Expires <time dateTime={ask.expiresAt}>{new Date(ask.expiresAt).toLocaleString()}</time>
      </small>
      {ask.byRule && <small>Auto-accepted by {ask.to.owner.login}’s rule</small>}
      {ask.reason && ask.reason !== "auto_accepted" && (
        <p>{plainReasons[ask.reason] ?? ask.reason}</p>
      )}
      {ask.state === "answered" && answer && (
        <section className="grid justify-items-start gap-1.5 border-t pt-2 text-sm">
          <strong>
            {ask.kind === "review"
              ? "Review result: " + answer.verdict?.replaceAll("_", " ")
              : "Answer"}
          </strong>
          {reviewed && (
            <p>
              {stale ? "Stale: reviewed at " : "Reviewed at "}
              <CommitSha sha={reviewed} />
            </p>
          )}
          <p className="whitespace-pre-wrap">{answer.text}</p>
          {ask.receipts.map((r) => (
            <small key={r.handle} className="block">
              {label(r.handle)} ·{" "}
              {r.tokens ? r.tokens.toLocaleString() + " tokens" : "No tokens reported"} ·{" "}
              {r.seconds} s{r.tools.length ? " · " + r.tools.join(", ") : ""}
            </small>
          ))}
          {ask.kind === "review" && viewer === ask.to.owner.login && postReview && !stale && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={post === "Posting..." || post === "Posted to GitHub"}
              onClick={async () => {
                setPost("Posting...");
                try {
                  await postReview();
                  setPost("Posted to GitHub");
                } catch (e) {
                  setPost(String(e));
                }
              }}
            >
              Post as review
            </Button>
          )}
          {post && <p role="status">{post}</p>}
        </section>
      )}
      {children}
    </section>
  );
}

export function TaskReviews({
  target,
  card,
  revision,
  owner,
}: {
  target: RelayTarget;
  card: BanneretBoardCard;
  revision: number;
  owner: string | undefined;
}) {
  const reviews = useChatRead(
    async () =>
      (
        await pageItems(async (cursor) =>
          decode(await chatRpc.run(target, { kind: "reviewAsks", ...(cursor && { cursor }) })),
        )
      ).filter((a) => a.kind === "review" && card.prs.some((p) => matchesReview(p, a.pr))),
    [card.task.id, card.prs.map((p) => p.number).join(","), revision].join(":"),
  );
  if (reviews.error) return <small role="alert">{reviews.error}</small>;
  return reviews.value?.map((ask) => (
    <AskCard
      key={ask.id}
      ask={ask}
      currentHead={card.prs.find((p) => matchesReview(p, ask.pr))?.headSha}
      viewer={owner}
      postReview={() => chatRpc.run(target, { kind: "postReview", id: ask.id })}
    />
  ));
}

function AskDecision({
  ask,
  change,
  busy,
  canAlways,
}: {
  ask: ChatAsk;
  change: (action: ChannelAction) => void;
  busy: boolean;
  canAlways: boolean;
}) {
  const [always, setAlways] = useState(false);
  const [mode, setMode] = useState<"answer" | "decline" | null>(null);
  const [text, setText] = useState(ask.answer?.text ?? "");
  const id = ask.id;
  if (ask.state === "draft")
    return (
      <fieldset disabled={busy}>
        <label>
          Draft answer
          <textarea value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <button
          disabled={!text.trim()}
          onClick={() => change({ kind: "askConfirm", id, confirm: { post: true, text } })}
        >
          Post answer
        </button>
        <button onClick={() => change({ kind: "askConfirm", id, confirm: { post: false } })}>
          Discard draft
        </button>
      </fieldset>
    );
  return (
    <fieldset disabled={busy} className="grid gap-2">
      <div className="flex flex-wrap gap-3">
        <button
          onClick={() =>
            change({
              kind: "askDecision",
              id,
              decision: always ? { allow: "always", kinds: [ask.kind] } : { allow: "once" },
            })
          }
        >
          {ask.kind === "review" ? "Review in a new thread" : "Let it answer"}
        </button>
        {ask.kind === "question" && (
          <>
            <button
              disabled={always}
              onClick={() => change({ kind: "askDecision", id, decision: { allow: "draft" } })}
            >
              Draft first
            </button>
            <button disabled={always} onClick={() => setMode("answer")}>
              Answer myself
            </button>
          </>
        )}
        <button disabled={always} onClick={() => setMode("decline")}>
          Decline
        </button>
      </div>
      {canAlways && (
        <label>
          <input
            type="checkbox"
            checked={always}
            onChange={(e) => {
              setAlways(e.target.checked);
              setMode(null);
            }}
          />{" "}
          Always allow {ask.from.owner.login}'s agents (
          {ask.kind === "review" ? "reviews" : "questions"})
        </label>
      )}
      {mode && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim())
              change(
                mode === "answer"
                  ? { kind: "answer", id, answer: { text } }
                  : { kind: "askDecision", id, decision: { decline: true, reason: text } },
              );
          }}
        >
          <label>
            {mode === "answer" ? "Your answer" : "Reason"}
            <textarea required value={text} onChange={(e) => setText(e.target.value)} />
          </label>
          <button disabled={!text.trim()}>
            {mode === "answer" ? "Send answer" : "Decline with reason"}
          </button>
        </form>
      )}
    </fieldset>
  );
}

export function WaitingAsks({
  item,
  target,
  chatRevision,
}: {
  item: BanneretFeedNeedsItem;
  target: RelayTarget;
  chatRevision?: number | undefined;
}) {
  const [revision, refresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const data = useChatRead(async () => {
    const load = (state: "waiting_owner" | "draft") =>
      pageItems(async (cursor) =>
        decode(
          await chatRpc.run(target, { kind: "ownerAsks", state, ...(cursor ? { cursor } : {}) }),
        ),
      );
    const [waiting, drafts, agents, current] = await Promise.all([
      load("waiting_owner"),
      load("draft"),
      handles(target),
      chatRpc.run(target, { kind: "dmSettings" }),
    ]);
    const policy = settings(current).agentAsks;
    const asks = [...waiting, ...drafts].filter((a) =>
      item.kind === "review_request"
        ? a.kind === "review" && a.id === item.id
        : a.kind === "question" && a.from.owner.login === item.owner?.login,
    );
    const channels = await conversations(target);
    const homes = new Map(
      await Promise.all(
        asks.map(
          async (ask) =>
            [ask.id, await askHome(target, ask, channels).catch(() => undefined)] as const,
        ),
      ),
    );

    // "Always allow" needs a member list that shows the asker as a member, not an outsider.
    const unseen = new Set(asks.map((ask) => ask.from.owner.id));
    const insiders = new Set<string>();
    for (const channel of channels) {
      if (!unseen.size) break;
      if (channel.kind !== "channel" || !channel.me.member) continue;
      for (const person of await members(target, channel.id).catch(() => []))
        if (unseen.delete(person.id) && person.admission === "member") insiders.add(person.id);
    }

    return {
      asks,
      insiders,
      homes,
      names: new Map(agents.map((h) => [h.id, h.login])),
      policy,
    };
  }, [revision, chatRevision, item.count, item.id].join(":"));
  async function change(action: ChannelAction) {
    setBusy(true);
    try {
      await chatRpc.run(target, action);
      setError("");
    } catch (e) {
      setError(String(e));
    }
    setBusy(false);
    refresh((n) => n + 1);
  }
  const homes = data.value?.homes;
  return (
    <li className="p-3">
      <strong>
        {item.kind === "review_request"
          ? "Review request"
          : item.owner?.login + "'s agents: " + item.count + " waiting"}
      </strong>
      {data.value?.asks.map((ask) => (
        <AskCard key={ask.id} ask={ask} names={data.value!.names}>
          <p>
            Answer shows in{" "}
            {homes?.get(ask.id) ? (
              <a href={homes.get(ask.id)?.href}>
                {homes.get(ask.id)?.label}
                {homes.get(ask.id)?.people !== undefined &&
                  " · " + homes.get(ask.id)?.people + " people in this conversation"}
              </a>
            ) : (
              "the shared thread (audience unavailable)"
            )}
          </p>
          <small>
            Runs read only on your usage. Stops at {data.value!.policy.maxTokens.toLocaleString()}{" "}
            tokens or {data.value!.policy.maxSeconds} seconds.
          </small>
          <AskDecision
            key={ask.state}
            ask={ask}
            change={change}
            busy={busy}
            // An ask between your own agents waits only because of its chain, so no rule applies.
            canAlways={
              data.value!.insiders.has(ask.from.owner.id) &&
              !(ask.to.kind === "agent" && ask.to.owner.id === ask.from.owner.id)
            }
          />
        </AskCard>
      ))}
      {(error || data.error) && <p role="alert">{error || data.error}</p>}
    </li>
  );
}
