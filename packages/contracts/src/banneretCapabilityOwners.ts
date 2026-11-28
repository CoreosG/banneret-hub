import * as Schema from "effect/Schema";

export type RelayCapability = "tasks" | "skills" | "memory" | "chat" | "search" | "health";

type Owner = { owner: "banneret" | "off" } | { owner: "external"; source: string };
type TasksOwner =
  | { owner: "off" }
  | { owner: "banneret"; leases: "banneret" }
  | { owner: "external"; source: string; leases: "provider" };

export type RelayOwners = Record<Exclude<RelayCapability, "tasks">, Owner> & { tasks: TasksOwner };

export interface RelaySource {
  id: string;
  title: string;
  url: string;
  prefix?: string;
  provides: readonly RelayCapability[];
  auth: { kind: "none" | "oauth" } | { kind: "bearer_per_person"; help?: string };
  check: {
    state:
      | "unchecked"
      | "checking"
      | "ok"
      | "shape_missing"
      | "degraded"
      | "auth_failed"
      | "reachable"
      | "down";
    checkedAt?: string;
    shape?: Partial<
      Record<
        RelayCapability,
        {
          required: "complete" | readonly string[];
          optional: readonly string[];
        }
      >
    >;
  };
}

/** Fields on the enrolled capabilities response. Older relays omit them. */
export interface RelayOwnershipFields {
  owners?: RelayOwners;
  sources?: readonly RelaySource[];
}

/** The capability a Banneret agent tool or skill resource belongs to. Null: a relay view or the Hub itself. */
export function toolCapability(name: string): RelayCapability | null {
  if (/^banneret_(board$|task$|lease_)/.test(name)) return "tasks";
  if (/^banneret_(chat_|agent_(ask|answer)$|handoff_offer$)/.test(name)) return "chat";
  if (name.startsWith("banneret_memory_")) return "memory";
  if (name.startsWith("banneret_skills_") || name.startsWith("skill://")) return "skills";
  if (name === "banneret_kb_search") return "search";
  return null;
}

/** Who has a capability when Banneret does not: a company source, or nobody. */
export const ElsewhereOwner = Schema.Union([
  Schema.Struct({
    owner: Schema.Literal("external"),
    source: Schema.String,
    title: Schema.String,
    /** The source's tool prefix, empty when it has none. */
    prefix: Schema.String,
    /**
     * Tasks only: the relay did not say the source's own claims count (`leases: provider`), so the Hub
     * offers no Take or Release.
     */
    leases: Schema.optionalKey(Schema.Literal("unsupported")),
  }),
  Schema.Struct({ owner: Schema.Literal("off") }),
]);
export type ElsewhereOwner = typeof ElsewhereOwner.Type;

/**
 * The capabilities a relay says Banneret does not own. An empty record means it published `owners` and
 * Banneret owns everything. Readers use `null` or `undefined` for a relay that published no `owners`, or
 * whose capabilities are unread: nothing is filtered then.
 */
export const ElsewhereOwners = Schema.Struct({
  tasks: Schema.optionalKey(ElsewhereOwner),
  skills: Schema.optionalKey(ElsewhereOwner),
  memory: Schema.optionalKey(ElsewhereOwner),
  chat: Schema.optionalKey(ElsewhereOwner),
  search: Schema.optionalKey(ElsewhereOwner),
  health: Schema.optionalKey(ElsewhereOwner),
});
export type ElsewhereOwners = typeof ElsewhereOwners.Type;

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
/** Relay text that ends up in agent instructions stays on one short line. */
const oneLine = (value: unknown, max: number) =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";

/** Reads `owners` and `sources` from a capabilities body; null when it carries no `owners`. */
export function elsewhereOwners(capabilities: unknown): ElsewhereOwners | null {
  const owners = record(record(capabilities)?.owners);
  if (!owners) return null;
  const listed = record(capabilities)?.sources;
  const sources = Array.isArray(listed) ? listed.map(record) : [];
  const result: { -readonly [K in RelayCapability]?: ElsewhereOwner } = {};
  for (const capability of Object.keys(ElsewhereOwners.fields) as RelayCapability[]) {
    const entry = record(owners[capability]);
    if (!entry || entry.owner === "banneret") continue;
    // An owner this Hub cannot name is still not Banneret.
    const id = oneLine(entry.source, 48);
    if (entry.owner !== "external" || !/^[a-z0-9][a-z0-9_-]*$/i.test(id)) {
      result[capability] = { owner: "off" };
      continue;
    }
    const source = sources.find((candidate) => candidate?.id === id);
    const prefix = oneLine(source?.prefix, 40);
    result[capability] = {
      owner: "external",
      source: id,
      title: oneLine(source?.title, 80) || id,
      prefix: /^[a-z0-9_]{1,31}_$/.test(prefix) ? prefix : "",
      ...(capability === "tasks" && entry.leases !== "provider"
        ? { leases: "unsupported" as const }
        : {}),
    };
  }
  return result;
}

const capabilityName: Record<RelayCapability, string> = {
  tasks: "Tasks",
  skills: "Skills",
  memory: "Memory",
  chat: "Chat",
  search: "Search",
  health: "Health",
};

/** The note shown where a user would look for a capability Banneret does not own. */
export const ownedElsewhereNote = (
  capability: RelayCapability,
  owner: ElsewhereOwner,
  company: string,
) =>
  owner.owner === "external"
    ? `${capabilityName[capability]}: owned by ${owner.title}.`
    : `${capabilityName[capability]}: turned off at ${company}.`;
