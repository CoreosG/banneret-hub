// @effect-diagnostics nodeBuiltinImport:off - a plain Node test double: it reads the canonical spec from disk.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeURL from "node:url";

import { toolCapability } from "@t3tools/contracts";
import type { RelayOwners, RelayOwnershipFields, RelayCapability } from "@t3tools/contracts";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import * as Yaml from "yaml";

/** The canonical contract: docs/banneret/relay-v1/ at the repository root. */
export const specDirectory = NodeURL.fileURLToPath(
  new URL("../../../docs/banneret/relay-v1/", import.meta.url),
);

const specUrl = "https://relay-v1.invalid/openapi.json";

export type SchemaName =
  | "RoleWrite"
  | "RoleDetail"
  | "Roles"
  | "RoleAssignment"
  | "RolesChangedEvent"
  | "ChatRequestInput"
  | "ChatJoinRequest"
  | "ChatJoinRequests"
  | "ChatWakeSetting"
  | "ChatMembership"
  | "ChatPerson"
  | "ChatMember"
  | "ChatMe"
  | "ChatConversation"
  | "ChatCard"
  | "ChatProgress"
  | "AskTarget"
  | "AskPr"
  | "AskReceipt"
  | "AgentAskPolicy"
  | "ChatDecision"
  | "ChatConfirm"
  | "ChatAsks"
  | "ChatNewHandoff"
  | "Handoff"
  | "HandoffAccept"
  | "HandoffReason"
  | "ChatHandoffs"
  | "AgentPause"
  | "ChatAsk"
  | "ChatAuthor"
  | "ChatMessage"
  | "ChatHandle"
  | "ChatActiveProgress"
  | "ChatDelivery"
  | "ChatRead"
  | "ChatChange"
  | "ChatChangedEvent"
  | "ChatDeliveryEvent"
  | "ChatChanges"
  | "ChatConversations"
  | "ChatMessages"
  | "ChatMembers"
  | "ChatHandles"
  | "ChatDeliveries"
  | "ChatSearch"
  | "ChatThread"
  | "ChatCreate"
  | "ChatPatch"
  | "ChatSettings"
  | "ChatNotifications"
  | "ChatPost"
  | "ChatEdit"
  | "ChatWriteProgress"
  | "ChatThreadLocation"
  | "ChatTask"
  | "ChatNewAsk"
  | "ChatAnswer"
  | "ChatRegister"
  | "ChatAct"
  | "ChatRefuse"
  | "ChatPromotion"
  | "ChatDefaultChannels"
  | "ChatLimits"
  | "CapabilityOwners"
  | "CapabilitySource"
  | "Capabilities"
  | "EnrolStartRequest"
  | "EnrolStartResponse"
  | "EnrolPollRequest"
  | "PoolPollResponse"
  | "EnrolPollResponse"
  | "FactsRequest"
  | "FactsResponse"
  | "MachinesPage"
  | "NeedsPage"
  | "RepositoriesPage"
  | "Alarm"
  | "Today"
  | "Error"
  | "NeedsChangedEvent"
  | "MentionEvent"
  | "BundleChangedEvent"
  | "StaffRemovedEvent"
  | "CapabilitiesChangedEvent"
  | "ResetEvent"
  | "SnapshotHead"
  | "SnapshotNeeds"
  | "HealthBlock"
  | "SnapshotWork"
  | "SnapshotMachines"
  | "SnapshotRepositories"
  | "SnapshotBoards"
  | "SnapshotBoard"
  | "SnapshotMap"
  | "FeedPage"
  | "GraveyardPage"
  | "TeamCounts"
  | "TeamStatus"
  | "TeamConfig"
  | "TeamMeeting"
  | "TeamEdit"
  | "TeamPresence"
  | "TeamChangedEvent"
  | "TeamRoomsChangedEvent"
  | "TeamPerson"
  | "SnapshotTeamPeople"
  | "SnapshotTeamRoom"
  | "TeamHeartbeats"
  | "TeamAgentsPage"
  | "SnapshotTeam"
  | "TaskRead"
  | "PoolPolicy"
  | "PoolNextResponse"
  | "PoolDirectives"
  | "PoolLimitsPolicy"
  | "PoolStateRefusal"
  | "PoolSlots"
  | "PoolHostLimits"
  | "PoolWarnings"
  | "PoolConfig"
  | "PoolMeter"
  | "PoolPsi"
  | "PoolQuota"
  | "Resources"
  | "HostContention"
  | "PoolSandbox"
  | "PoolWorkspace"
  | "PoolFounderView"
  | "PoolFounderAction"
  | "SkillsCatalog"
  | "PoolView"
  | "PoolWorkspaceRequest"
  | "PoolSandboxRequest"
  | "PoolHostFacts"
  | "PoolNextRequest"
  | "PoolOffer"
  | "PoolStateUpdate"
  | "Id";

export interface SpecValidator {
  /** Every schema under components/schemas. */
  readonly schemaNames: ReadonlyArray<string>;
  /** Null when `value` is valid, otherwise the first errors in plain words. */
  readonly check: (name: string, value: unknown) => string | null;
}

const describe = (errors: ReadonlyArray<ErrorObject> | null | undefined) =>
  (errors ?? [])
    .slice(0, 5)
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");

export const readOpenApi = (): Record<string, unknown> =>
  Yaml.parse(NodeFS.readFileSync(`${specDirectory}openapi.yaml`, "utf8")) as Record<
    string,
    unknown
  >;

// HTTP sources must resolve by their literal address or tailnet name on every Hub.
const privateNetworks = new NodeNet.BlockList();
privateNetworks.addSubnet("10.0.0.0", 8);
privateNetworks.addSubnet("172.16.0.0", 12);
privateNetworks.addSubnet("192.168.0.0", 16);
privateNetworks.addSubnet("100.64.0.0", 10);
privateNetworks.addSubnet("fc00::", 7, "ipv6");

function sourceUrlAllowed(value: string): boolean {
  const url = URL.parse(value);
  if (!url || url.username || url.password || url.hash || url.search) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host.endsWith(".ts.net")) return true;
  return (
    NodeNet.isIP(host) !== 0 &&
    privateNetworks.check(host, NodeNet.isIP(host) === 6 ? "ipv6" : "ipv4")
  );
}

export function offersOwnedTool(owners: RelayOwners, name: string): boolean {
  const capability = toolCapability(name);
  return capability === null || owners[capability].owner === "banneret";
}

export function ownershipError({
  owners,
  sources = [],
  mcpTools = [],
}: RelayOwnershipFields & {
  mcpTools?: readonly { name: string }[];
}): string | null {
  const byId = new Map(sources.map((source) => [source.id, source]));
  if (byId.size !== sources.length) return "Each source needs a unique id.";
  if (!owners) return null;
  for (const capability of Object.keys(owners) as RelayCapability[]) {
    const owner = owners[capability];
    if (owner.owner === "external" && !byId.get(owner.source)?.provides.includes(capability))
      return owner.source + " must declare that it provides " + capability + ".";
  }
  const hidden = mcpTools.find((tool) => !offersOwnedTool(owners, tool.name));
  return hidden ? hidden.name + " belongs to a capability that Banneret does not own." : null;
}

export const loadSpec = (): SpecValidator => {
  const doc = readOpenApi();
  const components = doc.components as { schemas: Record<string, unknown> };
  const schemas = components.schemas;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats.default(ajv);
  ajv.addKeyword({
    keyword: "x-sourceUrl",
    type: "string",
    validate: (_: boolean, url: string) => sourceUrlAllowed(url),
  });
  ajv.addKeyword({
    keyword: "x-maxBytes",
    type: "string",
    validate: (max: number, value: string) => Buffer.byteLength(value) <= max,
  });
  ajv.addKeyword({
    keyword: "x-maxJsonBytes",
    type: "object",
    validate: (cap: number, value: unknown) => Buffer.byteLength(JSON.stringify(value)) <= cap,
  });
  ajv.addSchema({ $id: specUrl, components: { schemas } });
  const compiled = new Map<string, ValidateFunction>();
  for (const name of Object.keys(schemas)) {
    const validate = ajv.getSchema(`${specUrl}#/components/schemas/${name}`);
    if (!validate) throw new Error(`relay-v1 schema ${name} did not compile`);
    compiled.set(name, validate);
  }
  return {
    schemaNames: [...compiled.keys()],
    check: (name, value) => {
      const validate = compiled.get(name);
      if (!validate) throw new Error(`relay-v1 has no schema ${name}`);
      if (!validate(value)) return describe(validate.errors);
      return name === "Capabilities" ? ownershipError(value as RelayOwnershipFields) : null;
    },
  };
};

/** The valid examples and the schema each one shows; the same map as the Go contract test. */
export const exampleSchemas: Readonly<Record<string, SchemaName>> = {
  "chat-person.json": "ChatPerson",
  "chat-member.json": "ChatMember",
  "chat-me.json": "ChatMe",
  "chat-conversation.json": "ChatConversation",
  "chat-card.json": "ChatCard",
  "chat-progress.json": "ChatProgress",
  "agent-policy.json": "AgentAskPolicy",
  "review-request.json": "ChatNewAsk",
  "handoff.json": "Handoff",
  "handoff-accept.json": "HandoffAccept",
  "ask-receipt.json": "AskReceipt",
  "chat-ask.json": "ChatAsk",
  "chat-ask-by-rule.json": "ChatAsk",
  "chat-author.json": "ChatAuthor",
  "chat-message.json": "ChatMessage",
  "chat-handle.json": "ChatHandle",
  "chat-active-progress.json": "ChatActiveProgress",
  "chat-delivery.json": "ChatDelivery",
  "chat-read.json": "ChatRead",
  "chat-change.json": "ChatChange",
  "chat-changed-event.json": "ChatChangedEvent",
  "chat-delivery-event.json": "ChatDeliveryEvent",
  "chat-changes.json": "ChatChanges",
  "chat-conversations.json": "ChatConversations",
  "chat-messages.json": "ChatMessages",
  "chat-members.json": "ChatMembers",
  "chat-handles.json": "ChatHandles",
  "chat-deliveries.json": "ChatDeliveries",
  "chat-search.json": "ChatSearch",
  "chat-thread.json": "ChatThread",
  "chat-create.json": "ChatCreate",
  "chat-patch.json": "ChatPatch",
  "chat-settings.json": "ChatSettings",
  "chat-notifications.json": "ChatNotifications",
  "chat-post.json": "ChatPost",
  "chat-edit.json": "ChatEdit",
  "chat-write-progress.json": "ChatWriteProgress",
  "chat-thread-location.json": "ChatThreadLocation",
  "chat-lease-echo.json": "ChatMessage",
  "chat-task.json": "ChatTask",
  "chat-new-ask.json": "ChatNewAsk",
  "chat-answer.json": "ChatAnswer",
  "chat-register.json": "ChatRegister",
  "chat-dm.json": "ChatConversation",
  "chat-ask-needs.json": "NeedsPage",
  "outside-pending.json": "Error",
  "outside-revoked.json": "Error",
  "role-detail.json": "RoleDetail",
  "chat-join-request.json": "ChatJoinRequest",
  "chat-act.json": "ChatAct",
  "chat-refuse.json": "ChatRefuse",
  "chat-promotion.json": "ChatPromotion",
  "chat-limits.json": "ChatLimits",
  "capabilities-public.json": "Capabilities",
  "source-missing-tools.json": "CapabilitySource",
  "capabilities-external.json": "Capabilities",
  "capabilities.json": "Capabilities",
  "enroll-start-request.json": "EnrolStartRequest",
  "enroll-start-response.json": "EnrolStartResponse",
  "enroll-poll-request.json": "EnrolPollRequest",
  "enroll-poll-awaiting.json": "EnrolPollResponse",
  "enroll-poll-approved.json": "EnrolPollResponse",
  "enroll-poll-refused.json": "EnrolPollResponse",
  "enroll-poll-expired.json": "EnrolPollResponse",
  "facts-request.json": "FactsRequest",
  "facts-response.json": "FactsResponse",
  "machines.json": "MachinesPage",
  "needs.json": "NeedsPage",
  "repositories.json": "RepositoriesPage",
  "pool-resources-local.json": "Resources",
  "pool-founder-view.json": "PoolFounderView",
  "pool-founder-action.json": "PoolFounderAction",
  "pool.json": "PoolView",
  "pool-config.json": "PoolConfig",
  "pool-next.json": "PoolNextResponse",
  "pool-refusal.json": "PoolStateRefusal",
  "pool-state.json": "PoolStateUpdate",
  "pool-facts.json": "PoolHostFacts",
  "alarm.json": "Alarm",
  "today.json": "Today",
  "error.json": "Error",
  "event-needs-changed.json": "NeedsChangedEvent",
  "event-mention.json": "MentionEvent",
  "event-bundle-changed.json": "BundleChangedEvent",
  "event-staff-removed.json": "StaffRemovedEvent",
  "event-capabilities-changed.json": "CapabilitiesChangedEvent",
  "event-reset.json": "ResetEvent",
  "snapshot-head.json": "SnapshotHead",
  "snapshot-head-no-repositories.json": "SnapshotHead",
  "snapshot-needs.json": "SnapshotNeeds",
  "snapshot-health.json": "HealthBlock",
  "snapshot-work.json": "SnapshotWork",
  "snapshot-machines.json": "SnapshotMachines",
  "snapshot-repositories.json": "SnapshotRepositories",
  "snapshot-boards.json": "SnapshotBoards",
  "snapshot-board.json": "SnapshotBoard",
  "snapshot-map.json": "SnapshotMap",
  "snapshot-map-not-measured.json": "SnapshotMap",
  "snapshot-feed.json": "FeedPage",
  "snapshot-graveyard.json": "GraveyardPage",
  "snapshot-team-people.json": "SnapshotTeamPeople",
  "snapshot-team-room.json": "SnapshotTeamRoom",
  "team-edit.json": "TeamEdit",
  "team-presence.json": "TeamPresence",
  "team-meeting.json": "TeamMeeting",
  "event-team-changed.json": "TeamChangedEvent",
  "event-team-rooms-changed.json": "TeamRoomsChangedEvent",
  "team-heartbeats.json": "TeamHeartbeats",
  "team-agents-page.json": "TeamAgentsPage",
  "snapshot-team.json": "SnapshotTeam",
  "task.json": "TaskRead",
  "task-checked-ignored.json": "TaskRead",
};

/** Invalid examples are refused facts, except the enrolment ones; the same rule as the Go contract test. */
const baseInvalidExampleSchema = (file: string): SchemaName =>
  exampleSchemas[file] ??
  (file.startsWith("alarm-")
    ? "Alarm"
    : file.startsWith("enroll-poll")
      ? "EnrolPollResponse"
      : file.startsWith("enroll-start")
        ? "EnrolStartRequest"
        : file.startsWith("repositories-")
          ? "RepositoriesPage"
          : file.startsWith("snapshot-head")
            ? "SnapshotHead"
            : file.startsWith("snapshot-machines")
              ? "SnapshotMachines"
              : file.startsWith("snapshot-repositories")
                ? "SnapshotRepositories"
                : file.startsWith("snapshot-work")
                  ? "SnapshotWork"
                  : file.startsWith("snapshot-boards")
                    ? "SnapshotBoards"
                    : file.startsWith("snapshot-board")
                      ? "SnapshotBoard"
                      : file.startsWith("snapshot-map")
                        ? "SnapshotMap"
                        : file.startsWith("snapshot-feed")
                          ? "FeedPage"
                          : file.startsWith("snapshot-graveyard")
                            ? "GraveyardPage"
                            : file.startsWith("snapshot-team")
                              ? "SnapshotTeam"
                              : file.startsWith("task-")
                                ? "TaskRead"
                                : file.startsWith("today-")
                                  ? "Today"
                                  : file.startsWith("snapshot-health")
                                    ? "HealthBlock"
                                    : "FactsRequest");

export const invalidExampleSchema = (file: string): SchemaName => {
  if (file.startsWith("ownership-")) return "Capabilities";
  if (file.startsWith("source-")) return "CapabilitySource";
  if (file.startsWith("owners-")) return "CapabilityOwners";
  if (file.startsWith("team-edit-")) return "TeamEdit";
  if (file.startsWith("team-meeting-")) return "TeamMeeting";
  if (file.startsWith("snapshot-team-room-")) return "SnapshotTeamRoom";
  if (file.startsWith("snapshot-team-people-")) return "SnapshotTeamPeople";
  if (file.startsWith("pool-next-")) return "PoolNextResponse";
  if (file.startsWith("pool-state-")) return "PoolStateUpdate";
  if (file.startsWith("pool-facts-")) return "PoolHostFacts";
  if (file.startsWith("pool-")) return "PoolView";
  return baseInvalidExampleSchema(file);
};

export const listExamples = (sub: "" | "invalid/"): ReadonlyArray<string> =>
  NodeFS.readdirSync(`${specDirectory}examples/${sub}`)
    // stage-plan.json follows stage-plan.schema.json, not openapi.yaml, so it has its own contract test.
    .filter((file) => file.endsWith(".json") && !file.startsWith("stage-plan"))
    .toSorted();

export const readExample = (file: string): unknown =>
  JSON.parse(NodeFS.readFileSync(`${specDirectory}examples/${file}`, "utf8"));
