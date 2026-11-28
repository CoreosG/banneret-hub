import { countLabel } from "../countLabel";
import { useState } from "react";
import * as Schema from "effect/Schema";
import {
  ChatConversations,
  ChatPerson,
  type BanneretFeedNeedsItem,
  type ChannelAction,
  type ChatConversation,
} from "@t3tools/contracts";
import type { RelayTarget } from "../enrolmentStore";
import type { EnterpriseFeed } from "../useEnterpriseFeed";
import { chatRpc, pageItems, useChatRead } from "./client";

const decodeDirectory = Schema.decodeUnknownSync(ChatConversations);
const decodeRequests = Schema.decodeUnknownSync(
  Schema.Struct({
    items: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        requester: ChatPerson,
        note: Schema.optionalKey(Schema.String),
      }),
    ),
    nextCursor: Schema.NullOr(Schema.String),
  }),
);

function useChange(target: RelayTarget) {
  const [revision, refresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function change(action: ChannelAction) {
    setBusy(true);
    try {
      await chatRpc.run(target, action);
      setError("");
    } catch (e) {
      setError(String(e));
    }
    refresh((n) => n + 1);
    setBusy(false);
  }
  return { revision, busy, error, change };
}

export function RequestControl({
  channel,
  busy,
  change,
}: {
  channel: Extract<ChatConversation, { kind: "channel" }>;
  busy: boolean;
  change: (action: ChannelAction) => void;
}) {
  const pending = channel.me.request;
  if (pending)
    return (
      <button disabled={busy} onClick={() => change({ kind: "cancelRequest", id: pending.id })}>
        Cancel request
      </button>
    );
  if (!channel.me.can.request) return null;
  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const note = String(new FormData(e.currentTarget).get("note") ?? "").trim();
        change({ kind: "request", id: channel.id, ...(note ? { note } : {}) });
      }}
    >
      <input aria-label="Request note" name="note" placeholder="Optional note" maxLength={200} />
      <button disabled={busy}>Request</button>
    </form>
  );
}

export function Directory({
  enterprise,
  open,
}: {
  enterprise: EnterpriseFeed;
  open: (id: string) => void;
}) {
  const { change, busy, error, revision } = useChange(enterprise.target);
  const rows = useChatRead(
    () =>
      pageItems(async (cursor) =>
        decodeDirectory(
          await chatRpc.run(enterprise.target, {
            kind: "directory",
            ...(cursor ? { cursor } : {}),
          }),
        ),
      ),
    revision + ":" + enterprise.feed.chatRevision,
  );
  return (
    <section className="grid gap-2 p-2 text-xs" aria-label="Channel directory">
      {rows.value?.map(
        (c) =>
          c.kind === "channel" && (
            <div key={c.id} className="grid gap-1 rounded border p-2">
              {c.me.can.read ? (
                <button onClick={() => open(c.id)}>#{c.name}</button>
              ) : (
                <strong>#{c.name}</strong>
              )}
              <span>{c.purpose}</span>
              <small>
                {countLabel(c.memberCount.people, "person", "people")} · {c.access.join}
              </small>
              {c.me.can.join && (
                <button disabled={busy} onClick={() => void change({ kind: "join", id: c.id })}>
                  Join
                </button>
              )}
              <RequestControl channel={c} busy={busy} change={change} />
            </div>
          ),
      )}
      {rows.value?.length === 0 && <p>No channels to browse.</p>}
      {(error || rows.error) && <p role="alert">{error || rows.error}</p>}
    </section>
  );
}

export function JoinRequests({
  item,
  target,
  people,
  revision,
}: {
  item: BanneretFeedNeedsItem;
  target: RelayTarget;
  people?: readonly { id: string; role: { name: string } }[] | undefined;
  revision?: number | undefined;
}) {
  const [open, setOpen] = useState(false);
  const action = useChange(target);
  const id = item.conversationId;
  const rows = useChatRead(
    () =>
      open && id
        ? pageItems(async (cursor) =>
            decodeRequests(
              await chatRpc.run(target, { kind: "requests", id, ...(cursor ? { cursor } : {}) }),
            ),
          )
        : Promise.resolve([]),
    [id, open, action.revision, revision, item.count].join(":"),
  );
  return (
    <li className="grid gap-2 rounded-md border p-3">
      <button
        aria-expanded={open}
        className="text-left font-semibold"
        onClick={() => setOpen(!open)}
      >
        {item.count} {item.count === 1 ? "person" : "people"} asked to join{" "}
        {item.title.replace(/^Requests to join /, "")}
      </button>
      {open && (
        <>
          <small>Approving adds them immediately and shares the channel history.</small>
          {rows.value?.map((r) => (
            <div key={r.id} className="flex items-center gap-2 border-t py-2">
              <div className="grow">
                <strong>{r.requester.login}</strong>{" "}
                {people?.find((p) => p.id === r.requester.id)?.role.name}
                <p>{r.note || "No note"}</p>
              </div>
              <button
                disabled={action.busy}
                onClick={() => void action.change({ kind: "decline", id: r.id })}
              >
                Decline
              </button>
              <button
                disabled={action.busy}
                onClick={() => void action.change({ kind: "approve", id: r.id })}
              >
                Approve
              </button>
            </div>
          ))}
        </>
      )}
      {(action.error || rows.error) && <p role="alert">{action.error || rows.error}</p>}
    </li>
  );
}
