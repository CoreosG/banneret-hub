import * as Schema from "effect/Schema";

export const ChatPerson = Schema.Struct({ id: Schema.String, login: Schema.String });
export type ChatPerson = typeof ChatPerson.Type;

export const ChatMember = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(["person"]), id: Schema.String, login: Schema.String }),
  Schema.Struct({
    kind: Schema.Literals(["agent"]),
    id: Schema.String,
    handle: Schema.String,
    ownerLogin: Schema.String,
  }),
]);
export type ChatMember = typeof ChatMember.Type;

export const ChatMe = Schema.Struct({
  member: Schema.Boolean,
  notify: Schema.Literals(["all", "mentions", "nothing"]),
  muted: Schema.Boolean,
  readSeq: Schema.Int,
  unread: Schema.Int,
  mentions: Schema.Int,
});
export type ChatMe = typeof ChatMe.Type;

export const ChatConversation = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals(["channel"]),
    name: Schema.String,
    private: Schema.Boolean,
    id: Schema.String,
    purpose: Schema.String,
    agents: Schema.Literals(["allowed", "mentions_only", "off"]),
    memberCount: Schema.Struct({ people: Schema.Int, agents: Schema.Int }),
    archived: Schema.Boolean,
    lastSeq: Schema.Int,
    me: ChatMe,
  }),
  Schema.Struct({
    kind: Schema.Literals(["dm"]),
    private: Schema.Literal(true),
    members: Schema.Array(ChatMember),
    agentReaders: Schema.Array(Schema.Struct({ personId: Schema.String, login: Schema.String })),
    id: Schema.String,
    purpose: Schema.String,
    agents: Schema.Literals(["allowed", "mentions_only", "off"]),
    memberCount: Schema.Struct({ people: Schema.Int, agents: Schema.Int }),
    archived: Schema.Boolean,
    lastSeq: Schema.Int,
    me: ChatMe,
  }),
]);
export type ChatConversation = typeof ChatConversation.Type;

export const ChatCard = Schema.Struct({
  title: Schema.String,
  tone: Schema.Literals(["ok", "warn", "error", "info"]),
  fields: Schema.Array(Schema.Struct({ label: Schema.String, value: Schema.String })),
  links: Schema.Array(Schema.Struct({ label: Schema.String, url: Schema.String })),
});
export type ChatCard = typeof ChatCard.Type;

export const ChatProgress = Schema.Struct({
  state: Schema.Literals(["working", "stale", "done", "blocked", "stopped"]),
  steps: Schema.Array(Schema.Struct({ title: Schema.String, state: Schema.String })),
});
export type ChatProgress = typeof ChatProgress.Type;

export const ChatAsk = Schema.Struct({
  id: Schema.String,
  to: ChatPerson,
  choices: Schema.Array(Schema.String),
  state: Schema.Literals(["open", "answered", "cancelled", "expired", "orphaned"]),
  answerMessageId: Schema.optionalKey(Schema.String),
});
export type ChatAsk = typeof ChatAsk.Type;

export const ChatAuthor = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(["person"]), id: Schema.String, login: Schema.String }),
  Schema.Struct({
    kind: Schema.Literals(["agent"]),
    id: Schema.String,
    handle: Schema.String,
    ownerLogin: Schema.String,
    provider: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literals(["system"]) }),
]);
export type ChatAuthor = typeof ChatAuthor.Type;

export const ChatMessage = Schema.Struct({
  id: Schema.String,
  conversationId: Schema.String,
  threadRootId: Schema.optionalKey(Schema.String),
  seq: Schema.Int,
  author: ChatAuthor,
  kind: Schema.Literals(["text", "progress", "ask", "system"]),
  text: Schema.String,
  card: Schema.optionalKey(ChatCard),
  systemEvent: Schema.optionalKey(Schema.String),
  progress: Schema.optionalKey(ChatProgress),
  ask: Schema.optionalKey(ChatAsk),
  taskRef: Schema.optionalKey(Schema.String),
  mentions: Schema.Array(
    Schema.Struct({ kind: Schema.Literals(["person", "agent"]), id: Schema.String }),
  ),
  replyCount: Schema.Int,
  lastReplyAt: Schema.optionalKey(Schema.String),
  reactions: Schema.Array(
    Schema.Struct({ emoji: Schema.String, count: Schema.Int, mine: Schema.Boolean }),
  ),
  createdAt: Schema.String,
  editedAt: Schema.optionalKey(Schema.String),
  deleted: Schema.Boolean,
});
export type ChatMessage = typeof ChatMessage.Type;

export const ChatHandle = Schema.Struct({
  id: Schema.String,
  owner: ChatPerson,
  claimName: Schema.String,
  shortName: Schema.optionalKey(Schema.String),
  provider: Schema.String,
  machine: Schema.Struct({ id: Schema.String, label: Schema.String }),
  reachable: Schema.Boolean,
  wake: Schema.Literals(["everyone", "owner_only"]),
});
export type ChatHandle = typeof ChatHandle.Type;

export const ChatActiveProgress = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({ handleId: Schema.String, threadRef: Schema.String, message: ChatMessage }),
  ),
  nextCursor: Schema.NullOr(Schema.String),
});

export const ChatDelivery = Schema.Struct({
  threadRef: Schema.String,
  wake: Schema.Literals(["everyone", "owner_only"]),
  message: ChatMessage,
  id: Schema.String,
  handleId: Schema.String,
  messageId: Schema.String,
  machineId: Schema.String,
  reason: Schema.Literals(["answer", "mention", "dm", "follow"]),
  fromOwner: Schema.Boolean,
  state: Schema.Literals(["pending", "claimed", "consumed", "refused", "expired"]),
  expiresAt: Schema.String,
});
export type ChatDelivery = typeof ChatDelivery.Type;

export const ChatRead = Schema.Struct({
  conversationId: Schema.String,
  threadRootId: Schema.optionalKey(Schema.String),
  seq: Schema.Int,
});
export type ChatRead = typeof ChatRead.Type;

export const ChatChange = Schema.Union([
  Schema.Struct({
    seq: Schema.Int,
    kind: Schema.Literals(["message.created", "message.edited", "message.deleted"]),
    message: ChatMessage,
  }),
  Schema.Struct({ seq: Schema.Int, kind: Schema.Literals(["read.moved"]), read: ChatRead }),
  Schema.Struct({
    seq: Schema.Int,
    kind: Schema.Literals([
      "reaction",
      "member.added",
      "member.removed",
      "conversation.updated",
      "settings.updated",
      "ask.updated",
      "task_thread.linked",
      "handle.updated",
    ]),
    refId: Schema.String,
    conversationId: Schema.optionalKey(Schema.String),
  }),
]);
export type ChatChange = typeof ChatChange.Type;

export const ChatNotice = Schema.Struct({
  messageId: Schema.String,
  author: Schema.String,
  text: Schema.String,
});
export type ChatNotice = typeof ChatNotice.Type;

export const ChatChangedEvent = Schema.Struct({
  seq: Schema.Int,
  change: Schema.optionalKey(ChatChange),
  notice: Schema.optionalKey(ChatNotice),
});
export type ChatChangedEvent = typeof ChatChangedEvent.Type;

export const ChatDeliveryEvent = Schema.Struct({
  deliveryId: Schema.String,
  handleId: Schema.String,
});
export type ChatDeliveryEvent = typeof ChatDeliveryEvent.Type;

export const ChatChanges = Schema.Struct({
  items: Schema.Array(ChatChange),
  nextSeq: Schema.Int,
  resync: Schema.Boolean,
});
export type ChatChanges = typeof ChatChanges.Type;

export const ChatConversations = Schema.Struct({
  items: Schema.Array(ChatConversation),
  nextCursor: Schema.NullOr(Schema.String),
});
export type ChatConversations = typeof ChatConversations.Type;

export const ChatMessages = Schema.Struct({
  items: Schema.Array(ChatMessage),
  nextCursor: Schema.NullOr(Schema.String),
});
export type ChatMessages = typeof ChatMessages.Type;

export const ChatMembers = Schema.Struct({
  items: Schema.Array(ChatMember),
  nextCursor: Schema.NullOr(Schema.String),
});
export type ChatMembers = typeof ChatMembers.Type;

export const ChatHandles = Schema.Struct({
  items: Schema.Array(ChatHandle),
  nextCursor: Schema.NullOr(Schema.String),
});
export type ChatHandles = typeof ChatHandles.Type;

export const ChatDeliveries = Schema.Struct({
  items: Schema.Array(ChatDelivery),
  nextCursor: Schema.NullOr(Schema.String),
});
export type ChatDeliveries = typeof ChatDeliveries.Type;

export const ChatSearch = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      messageId: Schema.String,
      conversationId: Schema.String,
      threadRootId: Schema.optionalKey(Schema.String),
      snippet: Schema.String,
    }),
  ),
  nextCursor: Schema.NullOr(Schema.String),
});
export type ChatSearch = typeof ChatSearch.Type;

export const ChatThread = Schema.Struct({
  root: ChatMessage,
  items: Schema.Array(ChatMessage),
  nextCursor: Schema.NullOr(Schema.String),
});
export type ChatThread = typeof ChatThread.Type;

export const ChatCreate = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals(["channel"]),
    name: Schema.String,
    purpose: Schema.optionalKey(Schema.String),
    private: Schema.Boolean,
    agents: Schema.Literals(["allowed", "mentions_only", "off"]),
  }),
  Schema.Struct({ kind: Schema.Literals(["dm"]), members: Schema.Array(Schema.String) }),
]);
export type ChatCreate = typeof ChatCreate.Type;

export const ChatPatch = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  purpose: Schema.optionalKey(Schema.String),
  private: Schema.optionalKey(Schema.Boolean),
  agents: Schema.optionalKey(Schema.Literals(["allowed", "mentions_only", "off"])),
  archived: Schema.optionalKey(Schema.Boolean),
});
export type ChatPatch = typeof ChatPatch.Type;

export const ChatSettings = Schema.Struct({ agentsReadMyDms: Schema.Boolean });
export type ChatSettings = typeof ChatSettings.Type;

export const ChatNotifications = Schema.Struct({
  notify: Schema.Literals(["all", "mentions", "nothing"]),
  muted: Schema.Boolean,
});
export type ChatNotifications = typeof ChatNotifications.Type;

export const ChatPost = Schema.Struct({
  conversationId: Schema.String,
  threadRootId: Schema.optionalKey(Schema.String),
  text: Schema.String,
  card: Schema.optionalKey(ChatCard),
  taskRef: Schema.optionalKey(Schema.String),
  key: Schema.String,
  asHandle: Schema.optionalKey(Schema.String),
});
export type ChatPost = typeof ChatPost.Type;

export const ChatEdit = Schema.Struct({
  text: Schema.String,
  card: Schema.optionalKey(ChatCard),
  asHandle: Schema.optionalKey(Schema.String),
});
export type ChatEdit = typeof ChatEdit.Type;

export const ChatWriteProgress = Schema.Struct({
  text: Schema.String,
  state: Schema.Literals(["working", "done", "blocked", "stopped"]),
  steps: Schema.optionalKey(
    Schema.Array(Schema.Struct({ title: Schema.String, state: Schema.String })),
  ),
  asHandle: Schema.String,
});
export type ChatWriteProgress = typeof ChatWriteProgress.Type;

export const ChatThreadLocation = Schema.Struct({
  conversationId: Schema.String,
  threadRootId: Schema.String,
});

export const ChatTask = Schema.Struct({ taskRef: Schema.String });
export type ChatTask = typeof ChatTask.Type;

export const ChatNewAsk = Schema.Struct({
  to: Schema.String,
  question: Schema.String,
  choices: Schema.optionalKey(Schema.Array(Schema.String)),
  threadRootId: Schema.optionalKey(Schema.String),
  taskRef: Schema.optionalKey(Schema.String),
  key: Schema.String,
  asHandle: Schema.String,
});
export type ChatNewAsk = typeof ChatNewAsk.Type;

export const ChatAnswer = Schema.Union([
  Schema.Struct({ choice: Schema.String }),
  Schema.Struct({ text: Schema.String }),
]);
export type ChatAnswer = typeof ChatAnswer.Type;

export const ChatRegister = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  threadRef: Schema.String,
  provider: Schema.String,
  machineId: Schema.String,
  wake: Schema.optionalKey(Schema.Literals(["everyone", "owner_only"])),
});
export type ChatRegister = typeof ChatRegister.Type;

export const ChatAct = Schema.Struct({ asHandle: Schema.String });
export type ChatAct = typeof ChatAct.Type;

export const ChatRefuse = Schema.Struct({ asHandle: Schema.String, reason: Schema.String });
export type ChatRefuse = typeof ChatRefuse.Type;

export const ChatPromotion = Schema.Struct({ text: Schema.String, link: Schema.String });
export type ChatPromotion = typeof ChatPromotion.Type;

export const ChatLimits = Schema.Struct({
  maxTextBytes: Schema.Int,
  editWindowSeconds: Schema.Int,
  rate: Schema.Struct({
    postsPerMinute: Schema.Int,
    postsPerHour: Schema.Int,
    openAsks: Schema.Int,
    hopCap: Schema.Int,
    pairPerMinute: Schema.Int,
  }),
  retentionDays: Schema.Struct({ channels: Schema.Int, dms: Schema.Int }),
});
export type ChatLimits = typeof ChatLimits.Type;

const Id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/));
const Page = { cursor: Schema.optionalKey(Schema.String) };
export const ThreadChatAction = Schema.Struct({
  kind: Schema.Literal("threadChat"),
  thread: Schema.String,
  settings: Schema.optionalKey(
    Schema.Struct({ name: Schema.String, wake: Schema.Literals(["owner_only", "everyone"]) }),
  ),
});
export const ChannelAction = Schema.Union([
  ThreadChatAction,
  Schema.Struct({ kind: Schema.Literal("handles"), ...Page }),
  Schema.Struct({ kind: Schema.Literal("dmSettings") }),
  Schema.Struct({ kind: Schema.Literal("setDmSettings"), settings: ChatSettings }),
  Schema.Struct({ kind: Schema.Literals(["join", "leave", "follow", "unfollow"]), id: Id }),
  Schema.Struct({
    kind: Schema.Literal("reaction"),
    id: Id,
    emoji: Schema.String,
    add: Schema.Boolean,
  }),
  Schema.Struct({ kind: Schema.Literal("dm"), members: Schema.Array(Id) }),
  Schema.Struct({ kind: Schema.Literal("notifications"), id: Id, settings: ChatNotifications }),
  Schema.Struct({ kind: Schema.Literal("list"), ...Page }),
  Schema.Struct({
    kind: Schema.Literals(["messages", "thread", "members", "replyPreview"]),
    id: Id,
    ...Page,
  }),
  Schema.Struct({
    kind: Schema.Literal("create"),
    name: Schema.String,
    purpose: Schema.String,
    private: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("post"),
    id: Id,
    root: Schema.optionalKey(Id),
    text: Schema.String,
    key: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("answer"), id: Id, answer: ChatAnswer }),
  Schema.Struct({ kind: Schema.Literal("discuss"), id: Id }),
  Schema.Struct({ kind: Schema.Literal("edit"), id: Id, text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("delete"), id: Id }),
  Schema.Struct({ kind: Schema.Literal("read"), read: ChatRead }),
]);
export type ChannelAction = typeof ChannelAction.Type;
export const ChannelResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
  Schema.Struct({ ok: Schema.Literal(false), message: Schema.String }),
]);
export type ChannelResult = typeof ChannelResult.Type;

/** The device RPC permits only the people-channel calls implemented by the Hub. */
export function callChannel<A>(
  action: ChannelAction,
  call: (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown) => A,
): A {
  const page =
    "cursor" in action && action.cursor
      ? "?limit=100&cursor=" + encodeURIComponent(action.cursor)
      : "?limit=100";

  switch (action.kind) {
    case "threadChat":
      throw new Error("Thread chat settings require the owning Hub.");
    case "handles":
      return call("GET", "handles" + page);
    case "dmSettings":
      return call("GET", "me/settings");
    case "setDmSettings":
      return call("PUT", "me/settings", action.settings);
    case "follow":
    case "unfollow":
      return call(action.kind === "follow" ? "PUT" : "DELETE", "threads/" + action.id + "/follow");
    case "reaction":
      return call(
        action.add ? "PUT" : "DELETE",
        "messages/" + action.id + "/reactions/" + encodeURIComponent(action.emoji),
      );
    case "join":
    case "leave":
      return call(
        action.kind === "join" ? "PUT" : "DELETE",
        "conversations/" + action.id + "/members/@me",
      );
    case "list":
      return call("GET", "conversations" + page);
    case "members":
    case "messages":
      return call("GET", "conversations/" + action.id + "/" + action.kind + page);
    case "replyPreview":
      return call("GET", "threads/" + action.id + "?limit=3");
    case "thread":
      return call("GET", "threads/" + action.id + page);
    case "post":
      return call("POST", "messages", {
        conversationId: action.id,
        threadRootId: action.root,
        text: action.text,
        key: action.key,
      });
    case "dm":
      return call("POST", "conversations", { kind: "dm", members: action.members });
    case "notifications":
      return call("PUT", "conversations/" + action.id + "/settings", action.settings);
    case "create":
      return call("POST", "conversations", {
        kind: "channel",
        name: action.name,
        purpose: action.purpose,
        private: action.private,
        agents: "allowed",
      });
    case "answer":
      return call("POST", "asks/" + action.id + "/answer", action.answer);
    case "discuss":
      return call("PUT", "tasks/" + action.id + "/thread");
    case "edit":
      return call("PATCH", "messages/" + action.id, { text: action.text });
    case "delete":
      return call("DELETE", "messages/" + action.id);
    case "read":
      return call("POST", "read", action.read);
  }
}
