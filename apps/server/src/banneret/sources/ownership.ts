// Banneret Hub: a relay's last capability owners and the sources they name, saved so a start with the
// relay down keeps them. Only the relay feed writes. Thread sources read the file because the layer that
// issues a thread's MCP set sits below the feed, where the feed reference only answers "not joined".
// @effect-diagnostics nodeBuiltinImport:off - node:net classifies a source's literal IP address.
import * as NodeNet from "node:net";

import { ElsewhereOwners, type RelayCapability } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { relayHash } from "../relay/Enrolment.ts";
import { workspacesFilePath } from "../Workspaces.ts";

const Capability = Schema.Literals(["tasks", "skills", "memory", "chat", "search", "health"]);
const isCapability = Schema.is(Capability);
const AuthKind = Schema.Literals(["none", "oauth", "bearer_per_person"]);
const isAuthKind = Schema.is(AuthKind);

/** A company source as the Hub keeps it. Nothing in it is secret. */
const SavedSource = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  url: Schema.String,
  /** The source's tool prefix, empty when it has none. */
  prefix: Schema.String,
  provides: Schema.Array(Capability),
  auth: AuthKind,
});
export type SavedSource = typeof SavedSource.Type;

const SavedOwnership = Schema.Struct({
  /** The enrolment the owners were read for: relay origin and machine id. */
  key: Schema.String,
  owners: ElsewhereOwners,
  sources: Schema.Array(SavedSource),
});
export type SavedOwnership = typeof SavedOwnership.Type;

const SavedJson = Schema.fromJsonString(SavedOwnership);
const decodeSaved = Schema.decodeEffect(SavedJson);
const encodeSaved = Schema.encodeEffect(SavedJson);

/** A source that owns at least one capability here, with the capabilities it owns. */
export type CompanySource = SavedSource & {
  readonly owns: readonly [RelayCapability, ...RelayCapability[]];
};

export const companySources = (saved: SavedOwnership): ReadonlyArray<CompanySource> =>
  saved.sources.flatMap((source) => {
    const [first, ...rest] = source.provides.filter((capability) => {
      const owner = saved.owners[capability];
      return owner?.owner === "external" && owner.source === source.id;
    });
    return first ? [{ ...source, owns: [first, ...rest] as const }] : [];
  });

// The relay-v1 source rules, checked again here: the Hub later sends a person's credential to this URL.
const privateNetworks = new NodeNet.BlockList();
privateNetworks.addSubnet("10.0.0.0", 8);
privateNetworks.addSubnet("172.16.0.0", 12);
privateNetworks.addSubnet("192.168.0.0", 16);
privateNetworks.addSubnet("100.64.0.0", 10);
privateNetworks.addSubnet("fc00::", 7, "ipv6");

export function sourceUrlAllowed(value: string): boolean {
  const url = URL.parse(value);
  if (!url || url.username || url.password || url.hash || url.search) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host.endsWith(".ts.net")) return true;
  const family = NodeNet.isIP(host);
  return family !== 0 && privateNetworks.check(host, family === 6 ? "ipv6" : "ipv4");
}

// No dots: Codex splits config override keys on them. `banneret*` and T3's own server names are reserved.
const SOURCE_ID = /^(?!banneret|t3-code(?:-direct)?$)[a-z0-9][a-z0-9_-]{0,47}$/;

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const savedSource = (value: unknown): SavedSource | undefined => {
  const source = record(value);
  const auth = record(source?.auth)?.kind;
  const { id, title, url, prefix } = source ?? {};
  if (typeof id !== "string" || !SOURCE_ID.test(id) || !isAuthKind(auth)) return undefined;
  if (typeof url !== "string" || url.length > 2048 || !sourceUrlAllowed(url)) return undefined;
  return {
    id,
    // Titles reach agent-facing messages, so they stay on one short line.
    title: (typeof title === "string" && title.replace(/\s+/g, " ").trim().slice(0, 80)) || id,
    url,
    prefix: typeof prefix === "string" && /^[a-z0-9_]{0,31}_$/.test(prefix) ? prefix : "",
    provides: Array.isArray(source?.provides) ? source.provides.filter(isCapability) : [],
    auth,
  };
};

/** The sources `owners` names, from a capabilities body. A source the Hub cannot use is left out. */
export function ownedSources(
  capabilities: unknown,
  owners: ElsewhereOwners,
): ReadonlyArray<SavedSource> {
  const named = new Set(
    Object.values(owners).flatMap((owner) => (owner.owner === "external" ? [owner.source] : [])),
  );
  const listed = record(capabilities)?.sources;
  const seen = new Set<string>();
  return (Array.isArray(listed) ? listed : []).flatMap((entry) => {
    const source = savedSource(entry);
    if (!source || !named.has(source.id) || seen.has(source.id)) return [];
    seen.add(source.id);
    return [source];
  });
}

const location = Effect.fn("BanneretOwnership.location")(function* (relayOrigin: string) {
  const path = yield* Path.Path;
  return path.join(
    path.dirname(yield* workspacesFilePath),
    "capability-owners",
    `${relayHash(relayOrigin)}.json`,
  );
});

/** The saved owners for a relay; null when there are none or the file cannot be read. */
export const readSavedOwnership = Effect.fn("BanneretOwnership.read")(
  function* (relayOrigin: string) {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* location(relayOrigin);
    if (!(yield* fs.exists(file))) return null;
    return yield* decodeSaved(yield* fs.readFileString(file));
  },
  Effect.catch((error) =>
    Effect.logWarning("Could not read the saved capability owners", error).pipe(Effect.as(null)),
  ),
);

/** Replaces or removes a relay's saved owners. A failure is logged: the live owners still apply. */
export const writeSavedOwnership = Effect.fn("BanneretOwnership.write")(
  function* (relayOrigin: string, next: SavedOwnership | null) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = yield* location(relayOrigin);
    if (next === null) return yield* fs.remove(file, { force: true });
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    const staging = `${file}.staging-${process.pid}`;
    yield* fs.writeFileString(staging, yield* encodeSaved(next));
    yield* fs.rename(staging, file);
  },
  Effect.catch((error) => Effect.logWarning("Could not save the capability owners", error)),
);
