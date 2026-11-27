import { randomUUID } from "../../lib/utils";
import "./chat.css";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { LegendList } from "@legendapp/list/react";
import type { ChatConversation, ChatMember, ChatMessage, ChannelAction } from "@t3tools/contracts";
import { HashIcon, LockIcon, SendIcon, XIcon, UsersIcon } from "lucide-react";
import { SidebarInset } from "../../components/ui/sidebar";
import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";
import { isElectron } from "../../env";
import { relayKey } from "../enrolmentStore";
import { FilterBox } from "../ui/FilterBox";
import { QuietLine } from "../ui/QuietLine";
import { RelativeTime } from "../ui/RelativeTime";
import { useEnterpriseFeed, type EnterpriseFeed } from "../useEnterpriseFeed";
import { useTabsStore, keep } from "../tabs/tabsStore";
import {
  handles,
  conversations,
  conversationTitle,
  members,
  history,
  replyAuthors,
  chatRpc,
  useChatRead,
} from "./client";
import { chatHref } from "./ChannelRows";
import { Markdown } from "./Markdown";

type Person = Pick<Extract<ChatMember, { kind: "person" }>, "id" | "login">;
const day = new Intl.DateTimeFormat("en", { weekday: "long", month: "long", day: "numeric" });
const time = new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" });
const author = (m: ChatMessage) =>
  m.author.kind === "person"
    ? m.author.login
    : m.author.kind === "agent"
      ? m.author.handle
      : "System";
type View = { enterprise: EnterpriseFeed; id: string; root: string | undefined };
export function ChannelPage({ id, root }: Omit<View, "enterprise">) {
  const enterprise = useEnterpriseFeed();
  if (!enterprise?.feed.sectionsKnown || !enterprise.feed.sections.includes("chat"))
    return <QuietLine fact="This page is unavailable." />;
  return (
    <ChannelView
      key={relayKey(enterprise.target) + "/" + id}
      enterprise={enterprise}
      id={id}
      root={root}
    />
  );
}
export function DmPrivacy({
  channel,
  title,
  login,
}: {
  channel: Extract<ChatConversation, { kind: "dm" }>;
  title: string;
  login: string | undefined;
}) {
  return (
    <>
      <p>
        {channel.members.length === 2
          ? "Private to you and " + title + "."
          : "Private to the " + channel.members.length + " participants."}{" "}
        The relay's operator can read it.
      </p>
      {channel.members
        .filter((m) => m.kind === "agent")
        .map((h) => (
          <p key={h.id}>
            {h.ownerLogin === login
              ? "Messages go to your agent’s thread."
              : "Questions only. This agent takes instructions from " + h.ownerLogin + "."}
          </p>
        ))}
      {channel.agentReaders.map((p) => (
        <p key={p.personId}>{p.login}'s agents can read this conversation.</p>
      ))}
    </>
  );
}
function ChannelView({ enterprise, id, root }: View) {
  const { environmentId, relayOrigin } = enterprise.target;
  const load = () => conversations({ environmentId, relayOrigin });
  const loadPeople = () => members({ environmentId, relayOrigin }, id);
  const revision = enterprise.feed.chatRevision ?? 0;
  const rows = useChatRead(load, revision);
  const agents = useChatRead(
    () =>
      enterprise.feed.chatFlags?.includes("agents")
        ? handles(enterprise.target)
        : Promise.resolve([]),
    revision,
  );
  const people = useChatRead(loadPeople, revision);
  const channel = rows.value?.find((c) => c.id === id);
  const title = channel ? conversationTitle(channel, enterprise.enrolment.me?.login) : "";
  const router = useRouter();
  const [q, setQ] = useState("");
  const [showMembers, setMembers] = useState(false);
  const [error, setError] = useState("");
  const href = chatHref(id, root);
  const tabId = useTabsStore(
    (s) => s.tabs.find((t) => t.href === href && t.workspaceId === enterprise.workspace.id)?.id,
  );
  const open = (thread?: string) => void router.navigate({ href: chatHref(id, thread) });
  return (
    <SidebarInset data-chat-shell role="main">
      <WorkspacePageHeader electron={isElectron} className="border-b">
        <span className="text-sm">
          {enterprise.workspace.name} / {channel?.kind === "dm" ? "Direct messages" : "Channels"}
        </span>
      </WorkspacePageHeader>
      {rows.error && <p role="alert">{rows.error}</p>}
      {channel ? (
        <div data-chat-columns>
          <section data-chat-column>
            <header data-chat-heading>
              <div>
                <h1>
                  {channel.kind === "dm" ? <LockIcon size={20} /> : <HashIcon size={20} />}
                  {channel.kind === "channel" ? channel.name : title}
                </h1>
                {channel.kind === "dm" ? (
                  <DmPrivacy
                    channel={channel}
                    title={title}
                    login={enterprise.enrolment.me?.login}
                  />
                ) : (
                  <p>
                    {channel.purpose}{" "}
                    {channel.agents !== "off" && "Only an explicit @mention wakes another agent."}
                  </p>
                )}
              </div>
              <button onClick={() => setMembers(!showMembers)}>
                <UsersIcon size={15} />
                {channel.memberCount.people} people · {channel.memberCount.agents} agents
              </button>
              {channel.kind === "channel" && channel.me.member && (
                <label data-chat-notifications>
                  Notifications{" "}
                  <select
                    aria-label="Channel notifications"
                    value={channel.me.notify}
                    onChange={async (e) => {
                      const level = e.target.value;
                      if (level !== "all" && level !== "mentions" && level !== "nothing") return;
                      try {
                        await chatRpc.run(enterprise.target, {
                          kind: "notifications",
                          id,
                          settings: { notify: level, muted: false },
                        });
                        setError("");
                      } catch (e) {
                        setError(String(e));
                      }
                    }}
                  >
                    <option value="all">All</option>
                    <option value="mentions">Mentions</option>
                    <option value="nothing">Nothing</option>
                  </select>
                </label>
              )}
              <FilterBox
                value={q}
                onChange={setQ}
                label="Search conversation"
                placeholder={"Search " + title}
              />
            </header>
            {showMembers && (
              <section data-chat-members>
                <b>Members</b> {people.value?.map((p) => p.login).join(", ")} {people.error}
                {channel.kind === "channel" && (
                  <button
                    onClick={async () => {
                      try {
                        await chatRpc.run(enterprise.target, {
                          kind: channel.me.member ? "leave" : "join",
                          id,
                        });
                        setMembers(false);
                      } catch (e) {
                        setError(String(e));
                      }
                    }}
                  >
                    {channel.me.member ? "Leave channel" : "Join channel"}
                  </button>
                )}
              </section>
            )}
            {error && <p role="alert">{error}</p>}
            <Timeline
              enterprise={enterprise}
              channel={channel}
              root={undefined}
              people={[
                ...(people.value ?? []),
                ...(agents.value ?? []).filter(
                  (h) =>
                    enterprise.feed.chatFlags?.includes("others_agents") ||
                    h.owner === enterprise.enrolment.me?.login,
                ),
              ]}
              query={q}
              open={open}
              tabId={tabId}
            />
          </section>
          {root && (
            <aside data-chat-thread>
              <header data-chat-heading>
                <h2>Thread</h2>
                <ThreadFollow key={root} root={root} enterprise={enterprise} />
                <button aria-label="Close thread" onClick={() => open()}>
                  <XIcon size={18} />
                </button>
              </header>
              <Timeline
                key={root}
                enterprise={enterprise}
                channel={channel}
                root={root}
                people={[
                  ...(people.value ?? []),
                  ...(agents.value ?? []).filter(
                    (h) =>
                      enterprise.feed.chatFlags?.includes("others_agents") ||
                      h.owner === enterprise.enrolment.me?.login,
                  ),
                ]}
                query=""
                open={open}
                tabId={tabId}
              />
            </aside>
          )}
        </div>
      ) : (
        <QuietLine fact={rows.value ? "Channel unavailable." : "Loading channel."} />
      )}
    </SidebarInset>
  );
}
function ReplyAvatars({
  enterprise,
  message,
}: {
  enterprise: EnterpriseFeed;
  message: ChatMessage;
}) {
  const preview = useChatRead(
    () => replyAuthors(enterprise.target, message.id),
    message.replyCount,
  );
  return (
    <span data-chat-repliers>
      {preview.value?.map((name) => (
        <span key={name} aria-label={name}>
          {name.slice(0, 2).toUpperCase()}
        </span>
      ))}
    </span>
  );
}
function ThreadFollow({ enterprise, root }: { enterprise: EnterpriseFeed; root: string }) {
  const [following, setFollowing] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  return (
    <>
      <select
        aria-label="Thread notifications"
        disabled={pending}
        value={following === null ? "" : following ? "follow" : "unfollow"}
        onChange={async (e) => {
          const follow = e.target.value === "follow";
          setPending(true);
          try {
            await chatRpc.run(enterprise.target, {
              kind: follow ? "follow" : "unfollow",
              id: root,
            });
            setFollowing(follow);
            setError("");
          } catch (e) {
            setError(String(e));
          }
          setPending(false);
        }}
      >
        <option value="" disabled>
          Thread notifications
        </option>
        <option value="follow">Follow</option>
        <option value="unfollow">Unfollow</option>
      </select>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
function Timeline({
  enterprise,
  channel,
  root,
  people,
  query,
  open,
  tabId,
}: {
  enterprise: EnterpriseFeed;
  channel: ChatConversation;
  root: string | undefined;
  people: Person[];
  query: string;
  open: (root: string) => void;
  tabId: string | undefined;
}) {
  const { environmentId, relayOrigin } = enterprise.target;
  const [pages, setPages] = useState(1);
  const [localRevision, refresh] = useState(0);
  const [openingCursor] = useState(channel.me.readSeq);
  const [seekUnread] = useState(channel.me.unread > 0);
  const load = () =>
    history(
      { environmentId, relayOrigin },
      channel.id,
      root,
      pages,
      seekUnread ? openingCursor : undefined,
    );
  const read = useChatRead(load, [enterprise.feed.chatRevision, localRevision, pages].join(":"));
  const items = (read.value?.items ?? []).filter(
    (m) => !query || m.text.toLowerCase().includes(query.toLowerCase()),
  );
  const unreadIndex = root
    ? -1
    : items.findIndex((m) => m.seq > openingCursor && author(m) !== enterprise.enrolment.me?.login);
  const [seen, setSeen] = useState(0);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [editing, edit] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const pendingKey = useRef<{ text: string; key: string } | null>(null);
  const last = items.at(-1)?.seq;
  const sentRead = useRef(root ? 0 : channel.me.readSeq);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- advance only this person's private cursor to visible messages
  useEffect(() => {
    if (!seen || query || seen <= sentRead.current || !channel.me.member) return;
    sentRead.current = seen;
    void chatRpc
      .run(
        { environmentId, relayOrigin },
        {
          kind: "read",
          read: { conversationId: channel.id, ...(root ? { threadRootId: root } : {}), seq: seen },
        },
      )
      .catch((e) => {
        if (sentRead.current === seen) sentRead.current = 0;
        setError(String(e));
      });
  }, [seen, query, root, environmentId, relayOrigin, channel.id, channel.me.member]);
  async function write(action: ChannelAction) {
    if (busy) return false;
    setBusy(true);
    try {
      await chatRpc.run(enterprise.target, action);
      refresh((n) => n + 1);
      setError("");
      setBusy(false);
      return true;
    } catch (e) {
      setError(String(e));
      setBusy(false);
      return false;
    }
  }
  async function send() {
    const text = draft.trim();
    if (!text) return;
    const key = pendingKey.current?.text === text ? pendingKey.current.key : randomUUID();
    pendingKey.current = { text, key };
    if (
      await write(
        editing
          ? { kind: "edit", id: editing, text }
          : { kind: "post", id: channel.id, ...(root ? { root } : {}), text, key },
      )
    ) {
      if (tabId) keep(tabId);
      edit(null);
      setDraft("");
      pendingKey.current = null;
    }
  }
  function startEdit(m: ChatMessage) {
    edit(m.id);
    setDraft(m.text);
    input.current?.focus();
  }
  const mention = /(?:^|\s)@([\w/-]*)$/.exec(draft);
  return (
    <>
      {read.error && <p role="alert">{read.error}</p>}
      <div data-chat-scroll>
        {read.value?.more && (
          <button onClick={() => setPages((n) => n + 1)}>Load more messages</button>
        )}
        {!last && (
          <QuietLine
            fact={
              read.value
                ? query
                  ? "No matching messages."
                  : "No messages yet."
                : "Loading messages."
            }
          />
        )}
        {items.length > 0 && (
          <LegendList
            data={items}
            keyExtractor={(m) => m.id}
            estimatedItemSize={82}
            className="min-h-0 flex-1"
            initialScrollIndex={unreadIndex < 0 ? items.length - 1 : unreadIndex}
            maintainScrollAtEnd
            onViewableItemsChanged={({ viewableItems }) => {
              setSeen(Math.max(0, ...viewableItems.map((t) => t.item.seq)));
            }}
            renderItem={({ item: m, index }) => {
              const prior = items[index - 1];
              const date = new Date(m.createdAt);
              const newDay =
                !prior || date.toDateString() !== new Date(prior.createdAt).toDateString();
              const group =
                newDay || !prior || author(prior) !== author(m) || index === unreadIndex;
              return (
                <article data-chat-row data-index={index} key={m.id}>
                  {newDay && <div data-chat-day>{day.format(date)}</div>}
                  {index === unreadIndex && <div data-chat-new>New messages</div>}
                  <div data-chat-message>
                    <div data-chat-avatar data-hidden={!group}>
                      {author(m).slice(0, 2).toUpperCase()}
                    </div>
                    <div data-chat-content>
                      {group && (
                        <div data-chat-by>
                          <strong>{author(m)}</strong>
                          {m.author.kind === "agent" && (
                            <small>
                              Agent · {m.author.provider} · on behalf of {m.author.ownerLogin}
                            </small>
                          )}
                          <time dateTime={m.createdAt}>{time.format(date)}</time>
                        </div>
                      )}
                      {m.deleted ? <i>Message deleted</i> : <Markdown text={m.text} />}
                      {!m.deleted && m.progress && (
                        <section data-agent-progress>
                          <strong>
                            {m.progress.state === "stale"
                              ? "Cannot reach this agent"
                              : m.progress.state}
                          </strong>
                          <ul>
                            {m.progress.steps.map((step) => (
                              <li key={step.title}>
                                {step.title} · {step.state}
                              </li>
                            ))}
                          </ul>
                        </section>
                      )}
                      {!m.deleted && m.card && (
                        <section data-agent-card data-tone={m.card.tone}>
                          <strong>{m.card.title}</strong>
                          <dl>
                            {m.card.fields.map((f) => (
                              <div key={f.label}>
                                <dt>{f.label}</dt>
                                <dd>{f.value}</dd>
                              </div>
                            ))}
                          </dl>
                          {m.card.links
                            .filter(
                              (l) =>
                                /^https:\/\//i.test(l.url) ||
                                /^\/relay\/v1\/tasks\/[\w-]{1,64}$/.test(l.url),
                            )
                            .map((l) => (
                              <a
                                key={l.url}
                                href={new URL(l.url, relayOrigin).href}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {l.label}
                              </a>
                            ))}
                        </section>
                      )}
                      {m.editedAt && !m.deleted && <small>Edited</small>}
                      {!root && m.replyCount > 0 && (
                        <button data-chat-replies onClick={() => open(m.id)}>
                          <ReplyAvatars enterprise={enterprise} message={m} />
                          {m.replyCount} {m.replyCount === 1 ? "reply" : "replies"}
                          {m.lastReplyAt && (
                            <>
                              {" "}
                              · <RelativeTime at={m.lastReplyAt} prefix="last" />
                            </>
                          )}
                        </button>
                      )}
                    </div>
                    {m.reactions.length > 0 && (
                      <div>
                        {m.reactions.map((r) => (
                          <button
                            key={r.emoji}
                            disabled={busy}
                            aria-pressed={r.mine}
                            onClick={() =>
                              void write({
                                kind: "reaction",
                                id: m.id,
                                emoji: r.emoji,
                                add: !r.mine,
                              })
                            }
                          >
                            {r.emoji} {r.count}
                          </button>
                        ))}
                      </div>
                    )}
                    <div data-chat-actions>
                      {!m.deleted && enterprise.feed.chatFlags?.includes("reactions") && (
                        <button
                          disabled={busy}
                          aria-label="React with thumbs up"
                          onClick={() =>
                            void write({
                              kind: "reaction",
                              id: m.id,
                              emoji: "👍",
                              add: !m.reactions.find((r) => r.emoji === "👍")?.mine,
                            })
                          }
                        >
                          👍
                        </button>
                      )}
                      {!root && <button onClick={() => open(m.id)}>Reply in thread</button>}
                      <button
                        onClick={() =>
                          void navigator.clipboard
                            .writeText(
                              new URL(chatHref(channel.id, root ?? m.id), location.origin).href,
                            )
                            .catch((e) => setError(String(e)))
                        }
                      >
                        Copy link
                      </button>
                      {!m.deleted &&
                        m.author.kind === "person" &&
                        m.author.login === enterprise.enrolment.me?.login && (
                          <>
                            <button onClick={() => startEdit(m)}>Edit</button>
                            <button
                              disabled={busy}
                              onClick={() => void write({ kind: "delete", id: m.id })}
                            >
                              Delete
                            </button>
                          </>
                        )}
                    </div>
                  </div>
                </article>
              );
            }}
          />
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {channel.me.member && !channel.archived ? (
        <form
          data-chat-composer
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          {editing && (
            <button
              type="button"
              onClick={() => {
                edit(null);
                setDraft("");
              }}
            >
              Cancel edit
            </button>
          )}
          {mention && (
            <div data-chat-picker>
              {people
                .filter((p) => p.login.toLowerCase().startsWith(mention[1]!.toLowerCase()))
                .slice(0, 12)
                .map((p) => (
                  <button
                    type="button"
                    key={p.id}
                    onClick={() => {
                      setDraft(draft.slice(0, draft.lastIndexOf("@")) + "@" + p.login + " ");
                      input.current?.focus();
                    }}
                  >
                    @{p.login}
                  </button>
                ))}
            </div>
          )}
          <textarea
            ref={input}
            disabled={busy}
            value={draft}
            aria-label={
              root ? "Thread reply" : channel.kind === "dm" ? "Direct message" : "Channel message"
            }
            placeholder={
              root
                ? "Reply in thread"
                : "Message " + conversationTitle(channel, enterprise.enrolment.me?.login)
            }
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              } else if (e.key === "ArrowUp" && !draft) {
                const own = items.findLast(
                  (m) =>
                    !m.deleted &&
                    m.author.kind === "person" &&
                    m.author.login === enterprise.enrolment.me?.login,
                );
                if (own) {
                  e.preventDefault();
                  startEdit(own);
                }
              }
            }}
          />
          <button aria-label="Send message" disabled={busy || !draft.trim()}>
            <SendIcon size={16} />
          </button>
        </form>
      ) : (
        !channel.archived && (
          <button onClick={() => void write({ kind: "join", id: channel.id })}>
            Join channel to post
          </button>
        )
      )}
    </>
  );
}
