import { countLabel } from "../countLabel";
import { useState } from "react";
import { ChatMessages, type ChatConversation, type ChatMember } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { EnterpriseFeed } from "../useEnterpriseFeed";
import type { RelayTarget } from "../enrolmentStore";
import { chatRpc, useChatRead } from "./client";

const decodeMessages = Schema.decodeUnknownSync(ChatMessages);
async function historyCount(target: RelayTarget, id: string) {
  let count = 0;
  let cursor: string | null = null;
  do {
    const page = decodeMessages(
      await chatRpc.run(target, { kind: "messages", id, ...(cursor ? { cursor } : {}) }),
    );
    for (const message of page.items) count += Number(!message.deleted) + message.replyCount;
    cursor = page.nextCursor;
  } while (cursor);
  return count;
}

export function ChannelMembers({
  enterprise,
  channel,
  members,
  agents,
  changed,
}: {
  enterprise: EnterpriseFeed;
  channel: ChatConversation;
  members: readonly ChatMember[];
  agents: readonly { id: string; login: string; owner: string }[];
  changed: () => void;
}) {
  const [search, setSearch] = useState("");
  const [selected, select] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const people = members.filter((m) => m.kind === "person");
  const bots = members.filter((m) => m.kind === "agent");
  const candidates =
    channel.kind === "channel" && channel.me.can.invite
      ? [
          ...(enterprise.feed.team?.value?.people ?? []).map((p) => ({
            id: p.id,
            name: p.login,
            role: p.role.name,
            reason:
              p.admission !== "outside"
                ? ""
                : channel.access.outsiders === "none"
                  ? "This channel does not allow outside collaborators."
                  : !channel.me.can.manage
                    ? "Only managers can add outside collaborators."
                    : "",
          })),
          ...agents.map((h) => ({
            id: h.id,
            name: h.login,
            role: "Agent",
            reason:
              h.owner !== enterprise.enrolment.me?.login
                ? "Agents are added by their owner (" + h.owner + ")."
                : channel.agents === "off"
                  ? "Agents are off in this channel."
                  : "",
          })),
        ].map((p) => ({
          ...p,
          reason: members.some((m) => m.id === p.id) ? "Already in this channel." : p.reason,
        }))
      : [];
  const candidate = candidates.find((p) => p.id === selected);
  const count = useChatRead(
    () => (selected ? historyCount(enterprise.target, channel.id) : Promise.resolve(null)),
    [selected, channel.id, enterprise.feed.chatRevision].join(":"),
  );
  const agentRow = (b: (typeof bots)[number]) => (
    <li className="ml-5 py-1 text-sm" key={b.id}>
      {b.handle} <small>Agent of {b.ownerLogin}</small>
    </li>
  );
  return (
    <>
      {channel.kind === "channel" && channel.me.can.invite && (
        <details>
          <summary>Add people</summary>
          <input
            aria-label="Find people or agents"
            placeholder="Find people or agents"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              select(null);
            }}
          />
          <ul>
            {candidates
              .filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
              .map((p) => (
                <li className="flex gap-2 py-1" key={p.id}>
                  <span className="grow">
                    {p.name} <small>{p.role}</small>
                    {p.reason && <small className="block">{p.reason}</small>}
                  </span>
                  <button
                    disabled={!!p.reason || pending}
                    aria-label={"Add " + p.name}
                    onClick={() => select(p.id)}
                  >
                    Add
                  </button>
                </li>
              ))}
          </ul>
          {candidate && (
            <section className="rounded-md border bg-card p-3" aria-label="Confirm member">
              <strong>
                Add {candidate.name} to #{channel.name}?
              </strong>
              {typeof count.value === "number" && !count.error && (
                <p>
                  They will see {countLabel(count.value, "earlier message")} and{" "}
                  {countLabel(channel.memberCount.people, "person", "people")}.
                </p>
              )}
              <button disabled={pending} onClick={() => select(null)}>
                Cancel
              </button>
              <button
                disabled={
                  pending || !!candidate.reason || typeof count.value !== "number" || !!count.error
                }
                onClick={async () => {
                  setPending(true);
                  try {
                    await chatRpc.run(enterprise.target, {
                      kind: "addMember",
                      id: channel.id,
                      member: candidate.id,
                    });
                    select(null);
                    changed();
                    setError("");
                  } catch (e) {
                    setError(String(e));
                  }
                  setPending(false);
                }}
              >
                Confirm add
              </button>
            </section>
          )}
          {(error || count.error) && <p role="alert">{error || count.error}</p>}
        </details>
      )}
      <h3 className="mt-3 text-xs text-muted-foreground">People</h3>
      <ul>
        {people.map((p) => (
          <li key={p.id} className="border-b py-2">
            <b>{p.login}</b>{" "}
            {channel.kind === "channel" && channel.managers.some((m) => m.id === p.id) && (
              <span className="rounded border px-1">Manager</span>
            )}{" "}
            {p.admission === "outside" && <span data-chat-outside>Outside</span>}
            <span
              className={
                ["contractor", "founder"].includes(p.role.id)
                  ? "rounded border px-1 text-xs"
                  : "block text-xs text-muted-foreground"
              }
            >
              {p.role.name}
            </span>
            <ul>{bots.filter((b) => b.ownerLogin === p.login).map(agentRow)}</ul>
          </li>
        ))}
        {bots.filter((b) => !people.some((p) => p.login === b.ownerLogin)).map(agentRow)}
      </ul>
    </>
  );
}
