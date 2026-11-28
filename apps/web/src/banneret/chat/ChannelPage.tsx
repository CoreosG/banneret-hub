import { countLabel } from "../countLabel";
import { matchesReview } from "./reviewPr";
import { AskCard } from "./AgentAskCards";
import { HandoffCards } from "./HandoffCards";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../../components/ui/sheet";
import { ChannelMembers } from "./ChannelMembers";
import { RequestControl } from "./JoinRequests";
import { randomUUID } from "../../lib/utils";
import "./chat.css";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { LegendList } from "@legendapp/list/react";
import type { ChatConversation, ChatMember, ChatMessage, ChannelAction } from "@t3tools/contracts";
import { allBoardCards } from "@t3tools/contracts";
import { useOpenTask } from "../useOpenTask";
import { LeaseChip } from "../ui/Chips";
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
  offersConversation,
  channelMembers,
  history,
  replyAuthors,
  chatRpc,
  useChatRead,
} from "./client";
import { ChannelSettings } from "./ChannelSettings";
import { chatHref } from "./ChannelRows";
import { PostToGitHub } from "./PostToGitHub";
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
type View = {
  enterprise: EnterpriseFeed;
  id: string;
  root: string | undefined;
  focus?: string | undefined;
};
export function ChannelPage({ id, root, focus }: Omit<View, "enterprise">) {
  const enterprise = useEnterpriseFeed();
  if (!enterprise?.feed.sectionsKnown || !enterprise.feed.sections.includes("chat"))
    return <QuietLine fact="This page is unavailable." />;
  return (
    <ChannelView
      key={relayKey(enterprise.target) + "/" + id + "/" + (focus ?? "")}
      enterprise={enterprise}
      id={id}
      root={enterprise.feed.chatFlags?.includes("threads") ? root : undefined}
      focus={focus}
    />
  );
}
export function DmPrivacy({
  channel,
  title,
  login,
  showAgentReaders,
}: {
  channel: Extract<ChatConversation, { kind: "dm" }>;
  title: string;
  login: string | undefined;
  showAgentReaders: boolean;
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
      {showAgentReaders &&
        channel.agentReaders.map((p) => (
          <p key={p.personId}>{p.login}'s agents can read this conversation.</p>
        ))}
    </>
  );
}
function ChannelView({ enterprise, id, root, focus }: View) {
  const { environmentId, relayOrigin } = enterprise.target;
  const load = () => conversations({ environmentId, relayOrigin });
  const flags = enterprise.feed.chatFlags ?? [];
  const revision = enterprise.feed.chatRevision ?? 0;
  const [membershipRevision, updateMembership] = useState(0);
  const membershipChanged = () => updateMembership((n) => n + 1);
  const rows = useChatRead(load, revision + ":" + membershipRevision);
  const agents = useChatRead(
    () =>
      enterprise.feed.chatFlags?.includes("agents")
        ? handles(enterprise.target)
        : Promise.resolve([]),
    revision,
  );
  const [missingAt, setMissingAt] = useState<number | null>(null);
  const missing = () => setMissingAt(revision);
  const channel =
    missingAt === revision
      ? undefined
      : rows.value?.find((c) => c.id === id && offersConversation(c, flags));
  const roster = useChatRead(
    () => (channel ? channelMembers({ environmentId, relayOrigin }, id) : Promise.resolve([])),
    revision + ":" + membershipRevision + ":" + (channel?.id ?? ""),
  );
  const people = roster.value?.filter((m) => m.kind === "person");
  const title = channel ? conversationTitle(channel, enterprise.enrolment.me?.login) : "";
  const router = useRouter();
  const [q, setQ] = useState("");
  const [settings, setSettings] = useState(false);
  const [showMembers, setMembers] = useState(false);
  const [error, setError] = useState("");
  const href = chatHref(id, root, focus);
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
                    showAgentReaders={
                      flags.includes("agents") && flags.includes("agent_owner_dm_read")
                    }
                    login={enterprise.enrolment.me?.login}
                  />
                ) : (
                  <p>
                    {channel.purpose}{" "}
                    {flags.includes("agents") &&
                      channel.agents !== "off" &&
                      "Only an explicit @mention reaches another agent."}
                  </p>
                )}
              </div>
              {channel.kind === "channel" && flags.includes("channel_access") && (
                <button onClick={() => setSettings(true)}>Channel settings</button>
              )}
              {settings && channel.kind === "channel" && (
                <ChannelSettings
                  key={JSON.stringify([channel.access, channel.managers, channel.agents])}
                  enterprise={enterprise}
                  channel={channel}
                  people={people}
                  close={() => setSettings(false)}
                  saved={membershipChanged}
                />
              )}
              <button onClick={() => setMembers(!showMembers)}>
                <UsersIcon size={15} />
                {countLabel(channel.memberCount.people, "person", "people")}
                {flags.includes("agents") &&
                  ` · ${countLabel(channel.memberCount.agents, "agent")}`}
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
              {flags.includes("search") && (
                <FilterBox
                  value={q}
                  onChange={setQ}
                  label="Search conversation"
                  placeholder={"Search " + title}
                />
              )}
            </header>
            {showMembers && (
              <Sheet
                open
                onOpenChange={(open) => {
                  if (!open) setMembers(false);
                }}
              >
                <SheetContent>
                  <SheetHeader>
                    <SheetTitle>
                      {channel.kind === "channel" ? "Members of #" + channel.name : "Members"}
                    </SheetTitle>
                    <p className="text-xs text-muted-foreground">
                      {countLabel(channel.memberCount.people, "person", "people")} ·{" "}
                      {countLabel(channel.memberCount.agents, "agent")}
                    </p>
                  </SheetHeader>
                  <section data-chat-members className="overflow-auto">
                    {roster.value && (
                      <ChannelMembers
                        enterprise={enterprise}
                        channel={channel}
                        members={roster.value}
                        agents={agents.value ?? []}
                        changed={membershipChanged}
                      />
                    )}{" "}
                    {roster.error}
                    {channel.kind === "channel" && !channel.defaultChannel && channel.me.member && (
                      <button
                        onClick={async () => {
                          try {
                            await chatRpc.run(enterprise.target, {
                              kind: "leave",
                              id,
                            });
                            membershipChanged();
                            setMembers(false);
                          } catch (e) {
                            setError(String(e));
                          }
                        }}
                      >
                        Leave channel
                      </button>
                    )}
                  </section>
                </SheetContent>
              </Sheet>
            )}
            {error && <p role="alert">{error}</p>}
            <Timeline
              enterprise={enterprise}
              channel={channel}
              root={undefined}
              focus={root ? undefined : focus}
              people={[
                ...(people ?? []),
                ...(flags.includes("agents") ? (agents.value ?? []) : []).filter(
                  (h) =>
                    (enterprise.enrolment.me?.permissions.includes("agents.mention") &&
                      enterprise.feed.chatFlags?.includes("others_agents")) ||
                    h.owner === enterprise.enrolment.me?.login,
                ),
              ]}
              query={flags.includes("search") ? q : ""}
              open={open}
              tabId={tabId}
              membershipChanged={membershipChanged}
              missing={missing}
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
                focus={focus}
                people={[
                  ...(people ?? []),
                  ...(flags.includes("agents") ? (agents.value ?? []) : []).filter(
                    (h) =>
                      (enterprise.enrolment.me?.permissions.includes("agents.mention") &&
                        enterprise.feed.chatFlags?.includes("others_agents")) ||
                      h.owner === enterprise.enrolment.me?.login,
                  ),
                ]}
                query=""
                open={open}
                tabId={tabId}
                membershipChanged={membershipChanged}
                missing={missing}
              />
            </aside>
          )}
        </div>
      ) : (
        <QuietLine
          fact={
            rows.value || rows.missing
              ? "This channel is no longer available to you."
              : "Loading channel."
          }
        />
      )}
    </SidebarInset>
  );
}
function composerRestriction(channel: ChatConversation) {
  const reason =
    channel.kind === "channel" &&
    channel.access.post === "roles" &&
    channel.access.postRoles?.join(",") === "founder"
      ? "Only founders can post here."
      : channel.kind === "channel" && channel.access.post === "managers"
        ? "Only managers can post here."
        : "This conversation is read-only.";
  return reason + (channel.me.can.reply ? " You can reply in threads." : "");
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
  membershipChanged,
  missing,
  focus,
}: {
  enterprise: EnterpriseFeed;
  channel: ChatConversation;
  root: string | undefined;
  focus?: string | undefined;
  people: Person[];
  query: string;
  open: (root: string) => void;
  tabId: string | undefined;
  membershipChanged: () => void;
  missing: () => void;
}) {
  const { environmentId, relayOrigin } = enterprise.target;
  const flags = enterprise.feed.chatFlags ?? [];
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
      focus,
    );
  const read = useChatRead(
    load,
    [enterprise.feed.chatRevision, localRevision, pages].join(":"),
    root ? undefined : missing,
  );
  const items = (read.value?.items ?? []).filter(
    (m) => !query || m.text.toLowerCase().includes(query.toLowerCase()),
  );
  const openTask = useOpenTask(enterprise.target);
  const tasks = new Map(
    allBoardCards(enterprise.feed.board?.value).map((card) => [card.task.id, card]),
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
      if (["join", "request", "cancelRequest"].includes(action.kind)) membershipChanged();
      refresh((n) => n + 1);
      setError("");
      setBusy(false);
      return true;
    } catch (e) {
      if (action.kind === "cancelRequest" || action.kind === "request") membershipChanged();
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
  if (read.missing) return <QuietLine fact="This channel is no longer available to you." />;
  return (
    <>
      {read.error && <p role="alert">{read.error}</p>}
      {root && flags.includes("handoffs") && (
        <HandoffCards enterprise={enterprise} threadRootId={root} />
      )}
      <div data-chat-scroll>
        {read.value?.more && (
          <button onClick={() => setPages((n) => n + 1)}>Load more messages</button>
        )}
        {!last && read.value && !root && !query && channel.kind === "channel" ? (
          <section data-chat-empty>
            <h2>Welcome to #{channel.name}</h2>
            <p>No messages yet.</p>
          </section>
        ) : (
          !last && (
            <QuietLine
              fact={
                read.value
                  ? query
                    ? "No matching messages."
                    : "No messages yet."
                  : "Loading messages."
              }
            />
          )
        )}
        {items.length > 0 && (
          <LegendList
            data={items}
            keyExtractor={(m) => m.id}
            estimatedItemSize={82}
            className="min-h-0 flex-1"
            initialScrollIndex={
              focus
                ? Math.max(
                    0,
                    items.findIndex((m) => m.id === focus),
                  )
                : unreadIndex < 0
                  ? items.length - 1
                  : unreadIndex
            }
            maintainScrollAtEnd
            onViewableItemsChanged={({ viewableItems }) => {
              setSeen(Math.max(0, ...viewableItems.map((t) => t.item.seq)));
            }}
            renderItem={({ item: m, index }) => {
              const task = m.taskRef && tasks.get(m.taskRef);
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
                          {flags.includes("agents") && m.author.kind === "agent" && (
                            <small>
                              Agent · {m.author.provider} · on behalf of {m.author.ownerLogin}
                            </small>
                          )}
                          <time dateTime={m.createdAt}>{time.format(date)}</time>
                        </div>
                      )}
                      {m.deleted ? (
                        <i>Message deleted</i>
                      ) : m.ask?.to.kind === "agent" ? (
                        <AskCard
                          ask={m.ask}
                          currentHead={
                            m.ask.pr &&
                            [...tasks.values()]
                              .flatMap((c) => c.prs)
                              .find((p) => matchesReview(p, m.ask?.pr))?.headSha
                          }
                          postReview={
                            m.ask.kind === "review" &&
                            flags.includes("promote") &&
                            m.ask.to.owner.login === enterprise.enrolment.me?.login
                              ? () =>
                                  chatRpc.run(enterprise.target, {
                                    kind: "postReview",
                                    id: m.ask!.id,
                                  })
                              : undefined
                          }
                          names={new Map(people.map((person) => [person.id, person.login]))}
                        />
                      ) : (
                        <Markdown text={m.text} />
                      )}
                      {!m.deleted && flags.includes("task_links") && m.taskRef && (
                        <div className="inline-flex items-center gap-2 rounded-md border px-2 py-1 text-xs">
                          {task ? (
                            <button
                              type="button"
                              className="text-left hover:underline"
                              onClick={() => openTask(task.task)}
                            >
                              {task.task.title}
                            </button>
                          ) : (
                            m.taskRef
                          )}
                          {task && task.lease && (
                            <LeaseChip
                              holder={task.lease.holder.login}
                              staleAt={task.lease.staleAt}
                              state={
                                task.lease.state === "active" || task.lease.state === "paused"
                                  ? task.lease.state
                                  : "stale"
                              }
                            />
                          )}
                        </div>
                      )}
                      {!m.deleted && flags.includes("agents") && m.progress && (
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
                      {!m.deleted && flags.includes("agents") && m.card && (
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
                                (flags.includes("task_links") &&
                                  /^\/relay\/v1\/tasks\/[\w-]{1,64}$/.test(l.url)),
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
                      {flags.includes("threads") && !root && m.replyCount > 0 && (
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
                    {flags.includes("reactions") && m.reactions.length > 0 && (
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
                    <details data-chat-actions>
                      <summary aria-label="Message actions">⋯</summary>
                      <div>
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
                        {!m.deleted && enterprise.feed.chatFlags?.includes("promote") && (
                          <PostToGitHub
                            enterprise={enterprise}
                            id={m.id}
                            linked={
                              m.taskRef ??
                              (root ? items.find((item) => item.id === root)?.taskRef : undefined)
                            }
                          />
                        )}
                        {flags.includes("threads") && !root && (
                          <button onClick={() => open(m.id)}>Reply in thread</button>
                        )}
                        <button
                          onClick={() =>
                            void navigator.clipboard
                              .writeText(
                                new URL(chatHref(channel.id, root, m.id), location.origin).href,
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
                    </details>
                  </div>
                </article>
              );
            }}
          />
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {!channel.archived && (root ? channel.me.can.reply : channel.me.can.post) ? (
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
        <div data-chat-composer>
          {channel.archived ? (
            "This channel is archived."
          ) : channel.kind === "channel" && channel.me.request ? (
            <>
              <RelativeTime prefix="Request sent" at={channel.me.request.createdAt} />
              <RequestControl channel={channel} busy={busy} change={write} />
            </>
          ) : channel.kind === "channel" && channel.me.can.join ? (
            <>
              <span>Join #{channel.name} to post</span>
              <button disabled={busy} onClick={() => void write({ kind: "join", id: channel.id })}>
                Join
              </button>
            </>
          ) : channel.kind === "channel" && channel.me.can.request ? (
            <>
              <span>Ask to join #{channel.name}</span>
              <RequestControl channel={channel} busy={busy} change={write} />
            </>
          ) : (
            composerRestriction(channel)
          )}
        </div>
      )}
    </>
  );
}
