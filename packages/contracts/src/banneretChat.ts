import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt } from "./baseSchemas.ts";

export const ChatPerson = Schema.Struct({ id: Schema.String, login: Schema.String });
export type ChatPerson = typeof ChatPerson.Type;

const RoleId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,31}$/));
export const RoleRef = Schema.Struct({ id: RoleId, name: Schema.NonEmptyString });
export const Admission = Schema.Literals(["member", "outside"]);
export const ChatWake = Schema.Literals(["everyone", "owner", "nobody"]);
export const ChatAccess = Schema.Struct({
  visibility: Schema.Literals(["public", "private"]),
  join: Schema.Literals(["open", "request", "invite"]),
  outsiders: Schema.Literals(["none", "invited", "listed"]),
  post: Schema.Literals(["everyone", "roles", "managers"]),
  postRoles: Schema.optionalKey(Schema.Array(RoleId)),
  replies: Schema.Literals(["everyone", "same_as_post"]),
  invite: Schema.Literals(["members", "managers"]),
}).check(
  Schema.makeFilter(
    (a) =>
      (a.visibility === "public" || (a.join === "invite" && a.outsiders !== "listed")) &&
      (a.post === "roles" ? !!a.postRoles?.length : a.postRoles === undefined),
  ),
);
export const ChatMember = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals(["person"]),
    id: Schema.String,
    login: Schema.String,
    role: RoleRef,
    admission: Admission,
  }),
  Schema.Struct({
    kind: Schema.Literals(["agent"]),
    id: Schema.String,
    handle: Schema.String,
    ownerLogin: Schema.String,
  }),
]);
export type ChatMember = typeof ChatMember.Type;

export const ChatMe = Schema.Struct({
  can: Schema.Struct({
    read: Schema.Boolean,
    post: Schema.Boolean,
    reply: Schema.Boolean,
    join: Schema.Boolean,
    request: Schema.Boolean,
    invite: Schema.Boolean,
    manage: Schema.Boolean,
    openToOutside: Schema.Boolean,
  }),
  request: Schema.optionalKey(Schema.Struct({ id: Schema.String, createdAt: Schema.String })),
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
    defaultChannel: Schema.optionalKey(Schema.Literal(true)),
    access: ChatAccess,
    managers: Schema.Array(ChatPerson),
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

export const AskTarget = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("person"),
    person: ChatPerson,
  }),
  Schema.Struct({
    kind: Schema.Literal("agent"),
    handle: Schema.String,
    owner: ChatPerson,
  }),
]);
export type AskTarget = typeof AskTarget.Type;

export const AskPr = Schema.Struct({
  repo: Schema.String,
  number: PositiveInt,
  headSha: Schema.String,
});
export type AskPr = typeof AskPr.Type;

export const AskReceipt = Schema.Struct({
  handle: Schema.String,
  tokens: NonNegativeInt,
  seconds: NonNegativeInt,
  tools: Schema.Array(Schema.String),
});
export type AskReceipt = typeof AskReceipt.Type;

export const AgentAskPolicy = Schema.Struct({
  default: Schema.Literals(["off", "approve"]),
  auto: Schema.Array(
    Schema.Union([
      Schema.Struct({
        from: Schema.Struct({
          person: ChatPerson,
        }),
        kinds: Schema.Array(Schema.Literals(["question", "review", "handoff"])),
      }),
      Schema.Struct({
        from: Schema.Struct({
          agent: Schema.String,
        }),
        kinds: Schema.Array(Schema.Literals(["question"])),
      }),
      Schema.Struct({
        from: Schema.Struct({
          role: RoleRef,
        }),
        kinds: Schema.Array(Schema.Literals(["question"])),
      }),
    ]),
  ),
  maxTokens: PositiveInt,
  maxSeconds: PositiveInt,
  usageWindowBelowPercent: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  ),
});
export type AgentAskPolicy = typeof AgentAskPolicy.Type;

export const ChatAsk = Schema.Struct({
  id: Schema.String,
  to: AskTarget,
  choices: Schema.Array(Schema.String),
  state: Schema.Literals([
    "waiting_owner",
    "open",
    "draft",
    "answered",
    "declined",
    "unanswered",
    "cancelled",
    "expired",
    "orphaned",
  ]),
  answerMessageId: Schema.optionalKey(Schema.String),
  kind: Schema.Literals(["question", "review"]),
  question: Schema.String,
  context: Schema.optionalKey(Schema.String),
  doneWhen: Schema.optionalKey(Schema.String),
  pr: Schema.optionalKey(AskPr),
  parentAskId: Schema.optionalKey(Schema.String),
  depth: PositiveInt,
  taskRef: Schema.optionalKey(Schema.String),
  mode: Schema.optionalKey(Schema.Literals(["answer", "draft"])),
  decidedBy: Schema.optionalKey(ChatPerson),
  reason: Schema.optionalKey(Schema.String),
  answer: Schema.optionalKey(
    Schema.Struct({
      text: Schema.String,
      choice: Schema.optionalKey(Schema.String),
      verdict: Schema.optionalKey(Schema.Literals(["clean", "findings", "could_not_review"])),
      headSha: Schema.optionalKey(Schema.String),
      by: Schema.Union([ChatPerson, Schema.String]),
    }),
  ),
  receipts: Schema.Array(AskReceipt),
  createdAt: Schema.String,
  expiresAt: Schema.String,
  closedAt: Schema.optionalKey(Schema.String),
  onBehalfOf: ChatPerson,
  from: Schema.Struct({
    handle: Schema.String,
    owner: ChatPerson,
  }),
});
export type ChatAsk = typeof ChatAsk.Type;

export const ChatDecision = Schema.Union([
  Schema.Struct({
    allow: Schema.Literals(["once", "draft", "always"]),
    kinds: Schema.optionalKey(Schema.Array(Schema.Literals(["question", "review"]))),
  }),
  Schema.Struct({
    decline: Schema.Literal(true),
    reason: Schema.String,
  }),
]);
export type ChatDecision = typeof ChatDecision.Type;

export const ChatConfirm = Schema.Union([
  Schema.Struct({
    post: Schema.Literal(true),
    text: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    post: Schema.Literal(false),
  }),
]);
export type ChatConfirm = typeof ChatConfirm.Type;

export const ChatAsks = Schema.Struct({
  items: Schema.Array(ChatAsk),
  nextCursor: Schema.NullOr(Schema.String),
});
export type ChatAsks = typeof ChatAsks.Type;

export const ChatNewHandoff = Schema.Struct({
  receipt: Schema.optionalKey(AskReceipt),
  taskId: Schema.String,
  to: ChatPerson,
  note: Schema.Struct({
    goal: Schema.String,
    done: Schema.String,
    next: Schema.String,
    risks: Schema.optionalKey(Schema.String),
  }),
  branch: Schema.optionalKey(Schema.String),
  headSha: Schema.optionalKey(Schema.String),
  expiresInSeconds: Schema.optionalKey(PositiveInt),
  threadRootId: Schema.optionalKey(Schema.String),
  asHandle: Schema.optionalKey(Schema.String),
  key: Schema.String,
});
export type ChatNewHandoff = typeof ChatNewHandoff.Type;

export const Handoff = Schema.Struct({
  fromMachineId: Schema.String,
  threadRootId: Schema.optionalKey(Schema.String),
  receipts: Schema.Array(AskReceipt),
  id: Schema.String,
  taskId: Schema.String,
  to: ChatPerson,
  note: Schema.Struct({
    goal: Schema.String,
    done: Schema.String,
    next: Schema.String,
    risks: Schema.optionalKey(Schema.String),
  }),
  branch: Schema.optionalKey(Schema.String),
  headSha: Schema.optionalKey(Schema.String),
  from: ChatPerson,
  fromHandle: Schema.optionalKey(Schema.String),
  state: Schema.Literals([
    "offered",
    "accepted",
    "declined",
    "withdrawn",
    "expired",
    "void",
    "closed",
  ]),
  outcome: Schema.optionalKey(Schema.Literals(["done", "lost"])),
  step: Schema.optionalKey(Schema.Literals(["waiting_release", "waiting_take"])),
  machineId: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
  createdAt: Schema.String,
  expiresAt: Schema.String,
  closedAt: Schema.optionalKey(Schema.String),
});
export type Handoff = typeof Handoff.Type;

export const HandoffAccept = Schema.Struct({
  byRule: Schema.optionalKey(Schema.Literal(true)),
  receipt: Schema.optionalKey(AskReceipt),
  machineId: Schema.optionalKey(Schema.String),
});
export type HandoffAccept = typeof HandoffAccept.Type;

export const HandoffReason = Schema.Struct({
  reason: Schema.optionalKey(Schema.String),
});
export type HandoffReason = typeof HandoffReason.Type;

export const ChatHandoffs = Schema.Struct({
  items: Schema.Array(Handoff),
  nextCursor: Schema.NullOr(Schema.String),
});
export type ChatHandoffs = typeof ChatHandoffs.Type;

export const AgentPause = Schema.Struct({
  paused: Schema.Boolean,
});
export type AgentPause = typeof AgentPause.Type;

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
  machine: Schema.Struct({
    id: Schema.String,
    label: Schema.String,
  }),
  reachable: Schema.Boolean,
  wake: Schema.Literals(["everyone", "owner", "nobody"]),
  paused: Schema.Boolean,
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
  wake: ChatWake,
  wakes: Schema.Boolean,
  message: ChatMessage,
  id: Schema.String,
  handleId: Schema.String,
  messageId: Schema.String,
  machineId: Schema.String,
  reason: Schema.Literals(["answer", "mention", "dm", "follow", "ask", "ask_result"]),
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
      "request.updated",
      "access.updated",
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
      conversationName: Schema.String,
      createdAt: Schema.String,
      author: ChatAuthor,
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

export const ChannelTemplate = Schema.Literals([
  "general",
  "team",
  "private",
  "announcement",
  "shared",
  "community",
]);
export const ChatCreate = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals(["channel"]),
    name: Schema.String,
    purpose: Schema.optionalKey(Schema.String),
    template: Schema.optionalKey(ChannelTemplate),
    access: Schema.optionalKey(ChatAccess),
    managers: Schema.optionalKey(Schema.Array(ChatPerson)),
    agents: Schema.optionalKey(Schema.Literals(["allowed", "mentions_only", "off"])),
  }).check(Schema.makeFilter((c) => (c.access === undefined) !== (c.template === undefined))),
  Schema.Struct({ kind: Schema.Literals(["dm"]), members: Schema.Array(Schema.String) }),
]);
export type ChatCreate = typeof ChatCreate.Type;

export const ChatPatch = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  purpose: Schema.optionalKey(Schema.String),
  access: Schema.optionalKey(ChatAccess),
  managers: Schema.optionalKey(Schema.Array(ChatPerson)),
  agents: Schema.optionalKey(Schema.Literals(["allowed", "mentions_only", "off"])),
  archived: Schema.optionalKey(Schema.Boolean),
});
export type ChatPatch = typeof ChatPatch.Type;

export const ChatSettings = Schema.Struct({
  agentWakeDefault: ChatWake,
  agentsReadMyDms: Schema.Boolean,
  agentAsks: AgentAskPolicy,
  agentsPaused: Schema.Boolean,
});
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
  receipt: Schema.optionalKey(AskReceipt),
  to: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("person"),
      person: Schema.String,
    }),
    Schema.Struct({
      kind: Schema.Literal("agent"),
      handle: Schema.String,
    }),
  ]),
  question: Schema.String,
  choices: Schema.optionalKey(Schema.Array(Schema.String)),
  threadRootId: Schema.optionalKey(Schema.String),
  taskRef: Schema.optionalKey(Schema.String),
  key: Schema.String,
  asHandle: Schema.String,
  kind: Schema.optionalKey(Schema.Literals(["question", "review"])),
  context: Schema.optionalKey(Schema.String),
  doneWhen: Schema.optionalKey(Schema.String),
  pr: Schema.optionalKey(AskPr),
  parentAskId: Schema.optionalKey(Schema.String),
  timeoutSeconds: Schema.optionalKey(PositiveInt.check(Schema.isLessThanOrEqualTo(604800))),
});
export type ChatNewAsk = typeof ChatNewAsk.Type;

export const ChatAnswer = Schema.Union([
  Schema.Struct({
    none: Schema.Literal(true),
    reason: Schema.String,
    asHandle: Schema.optionalKey(Schema.String),
    receipt: Schema.optionalKey(AskReceipt),
  }),
  Schema.Struct({
    text: Schema.optionalKey(Schema.String),
    choice: Schema.optionalKey(Schema.String),
    verdict: Schema.optionalKey(Schema.Literals(["clean", "findings", "could_not_review"])),
    headSha: Schema.optionalKey(Schema.String),
    asHandle: Schema.optionalKey(Schema.String),
    receipt: Schema.optionalKey(AskReceipt),
  }),
]);
export type ChatAnswer = typeof ChatAnswer.Type;

export const ChatRegister = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  threadRef: Schema.String,
  provider: Schema.String,
  machineId: Schema.String,
  wake: Schema.optionalKey(ChatWake),
});
export type ChatRegister = typeof ChatRegister.Type;

export const ChatAct = Schema.Struct({ asHandle: Schema.String });
export type ChatAct = typeof ChatAct.Type;

export const ChatRefuse = Schema.Struct({ asHandle: Schema.String, reason: Schema.String });
export type ChatRefuse = typeof ChatRefuse.Type;

export const ChatPromotion = Schema.Struct({ text: Schema.String, link: Schema.String });
export type ChatPromotion = typeof ChatPromotion.Type;

export const ChatLimits = Schema.Struct({
  boards: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        board: Schema.String,
        channel: Schema.String,
      }),
    ),
  ),
  maxTextBytes: Schema.Int,
  editWindowSeconds: Schema.Int,
  rate: Schema.Struct({
    postsPerMinute: Schema.Int,
    postsPerHour: Schema.Int,
    openAsks: Schema.Int,
    hopCap: Schema.Int,
    pairPerMinute: Schema.Int,
    agentAsks: Schema.Struct({
      pairOpen: Schema.Int,
      pairPerDay: Schema.Int,
      maxDepth: Schema.Int,
      sameQuestion: Schema.Int,
      declineCooloffSeconds: Schema.Int,
      defaultTimeoutSeconds: Schema.Int,
      maxTimeoutSeconds: Schema.Int,
    }),
    handoffs: Schema.Struct({
      expireAfterSeconds: Schema.Int,
      stallAfterSeconds: Schema.Int,
    }),
  }),
  retentionDays: Schema.Struct({
    channels: Schema.Int,
    dms: Schema.Int,
  }),
});
export type ChatLimits = typeof ChatLimits.Type;

const Id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/));
const Page = { cursor: Schema.optionalKey(Schema.String) };
export const ThreadChatAction = Schema.Struct({
  kind: Schema.Literal("threadChat"),
  thread: Schema.String,
  settings: Schema.optionalKey(Schema.Struct({ name: Schema.String, wake: ChatWake })),
});
export const RoleWrite = Schema.Struct({
  name: Schema.NonEmptyString,
  forOutside: Schema.Boolean,
  permissions: Schema.Record(
    Schema.String,
    Schema.Union([Schema.Literal(true), Schema.String, Schema.Array(Schema.String)]),
  ),
});
export const RoleDetail = Schema.Struct({
  ...RoleWrite.fields,
  ...RoleRef.fields,
  memberCount: Schema.Int,
  template: Schema.optionalKey(RoleId),
});
export type RoleDetail = typeof RoleDetail.Type;
export const RoleAction = Schema.Union([
  Schema.Struct({ op: Schema.Literal("list") }),
  Schema.Struct({ op: Schema.Literals(["reset", "delete"]), id: RoleId }),
  Schema.Struct({ op: Schema.Literal("save"), id: RoleId, role: RoleWrite }),
  Schema.Struct({ op: Schema.Literal("assign"), person: Id, roleId: RoleId }),
]);
export const HandoffOfferInput = Schema.Struct({
  taskId: Id,
  to: ChatPerson,
  note: ChatNewHandoff.fields.note,
  branch: Schema.NonEmptyString,
  headSha: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  expiresInSeconds: Schema.optionalKey(PositiveInt),
  threadRootId: Schema.optionalKey(Id),
  key: Id,
});
export const ChatAction = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("handoffs"), ...Page }),
  Schema.Struct({ kind: Schema.Literal("offerHandoff"), offer: HandoffOfferInput }),
  Schema.Struct({
    kind: Schema.Literals(["acceptHandoff", "advanceHandoff", "withdrawHandoff"]),
    id: Id,
  }),
  Schema.Struct({ kind: Schema.Literal("declineHandoff"), id: Id, reason: Schema.NonEmptyString }),
  ThreadChatAction,
  Schema.Struct({ kind: Schema.Literal("directory"), ...Page }),
  Schema.Struct({ kind: Schema.Literal("requests"), id: Id, ...Page }),
  Schema.Struct({
    kind: Schema.Literal("request"),
    id: Id,
    note: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literals(["cancelRequest", "approve", "decline"]), id: Id }),
  Schema.Struct({ kind: Schema.Literal("addMember"), id: Id, member: Id }),
  Schema.Struct({ kind: Schema.Literal("applyWake"), wake: ChatWake }),
  Schema.Struct({ kind: Schema.Literal("settings"), id: Id, patch: ChatPatch }),
  Schema.Struct({ kind: Schema.Literal("handles"), ...Page }),
  Schema.Struct({
    kind: Schema.Literal("ownerAsks"),
    state: Schema.Literals(["waiting_owner", "draft"]),
    ...Page,
  }),
  Schema.Struct({ kind: Schema.Literal("askDecision"), id: Id, decision: ChatDecision }),
  Schema.Struct({ kind: Schema.Literal("askConfirm"), id: Id, confirm: ChatConfirm }),
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
  Schema.Struct({ kind: Schema.Literal("search"), query: Schema.String, ...Page }),
  Schema.Struct({
    kind: Schema.Literal("promote"),
    id: Id,
    scope: Schema.String,
    key: Schema.String,
    host: Schema.String,
    hubOrigin: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("around"), id: Id, message: Id, ...Page }),
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
    template: ChannelTemplate,
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
export type ChannelAction =
  | typeof ChatAction.Type
  | { readonly kind: "roles"; readonly action: typeof RoleAction.Type };
export const ChannelResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
  Schema.Struct({
    ok: Schema.Literal(false),
    message: Schema.String,
    code: Schema.optionalKey(Schema.String),
  }),
]);
export type ChannelResult = typeof ChannelResult.Type;

/** The device RPC permits only the people-channel calls implemented by the Hub. */
export function callChannel<A>(
  action: ChannelAction,
  call: (
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    namespace?: "roles",
  ) => A,
): A {
  const page =
    "cursor" in action && action.cursor
      ? "?limit=100&cursor=" + encodeURIComponent(action.cursor)
      : "?limit=100";

  switch (action.kind) {
    case "handoffs":
      return call("GET", "handoffs" + page);
    case "declineHandoff":
      return call("POST", "handoffs/" + action.id + "/decline", { reason: action.reason });
    case "withdrawHandoff":
      return call("POST", "handoffs/" + action.id + "/withdraw", {});
    case "acceptHandoff":
    case "advanceHandoff":
    case "offerHandoff":
      throw new Error("Hand-off requires the owning Hub.");
    case "roles": {
      const r = action.action;
      switch (r.op) {
        case "list":
          return call("GET", "roles", undefined, "roles");
        case "save":
          return call("PUT", "roles/" + r.id, r.role, "roles");
        case "delete":
          return call("DELETE", "roles/" + r.id, undefined, "roles");
        case "reset":
          return call("POST", "roles/" + r.id + "/reset", undefined, "roles");
        case "assign":
          return call("PUT", "staff/" + r.person + "/role", { roleId: r.roleId }, "roles");
      }
    }
    case "settings":
      return call("PATCH", "conversations/" + action.id, action.patch);
    case "around":
      return call(
        "GET",
        "conversations/" + action.id + "/messages" + page + "&around=" + action.message,
      );
    case "search":
      return call("GET", "search" + page + "&q=" + encodeURIComponent(action.query));
    case "promote":
      throw new Error("Posting requires the owning Hub.");
    case "threadChat":
      throw new Error("Thread chat settings require the owning Hub.");
    case "handles":
      return call("GET", "handles" + page);
    case "directory":
      return call("GET", "directory" + page);
    case "requests":
      return call("GET", "conversations/" + action.id + "/requests" + page);
    case "request":
      return call("POST", "conversations/" + action.id + "/requests", { note: action.note });
    case "cancelRequest":
      return call("DELETE", "requests/" + action.id);
    case "approve":
    case "decline":
      return call("POST", "requests/" + action.id + "/" + action.kind);
    case "addMember":
      return call("PUT", "conversations/" + action.id + "/members/" + action.member);
    case "applyWake":
      return call("PUT", "me/agents/wake", { wake: action.wake });
    case "ownerAsks":
      return call("GET", "asks" + page + "&role=owner&state=" + action.state);
    case "askDecision":
      return call("POST", "asks/" + action.id + "/decision", action.decision);
    case "askConfirm":
      return call("POST", "asks/" + action.id + "/confirm", action.confirm);
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
        template: action.template,
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
