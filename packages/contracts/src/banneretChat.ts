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

export const ChatDelivery = Schema.Struct({
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

export const ChatChangedEvent = Schema.Struct({
  seq: Schema.Int,
  change: Schema.optionalKey(ChatChange),
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
  name: Schema.String,
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
