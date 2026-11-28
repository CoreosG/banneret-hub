// Banneret Hub: a person's own copy of a company server, set up in their own Codex or Claude settings,
// would skip the Hub's owner filtering, tool access and approvals. A Hub chat turns it off for its own
// session only. The Hub reads those settings and never writes them. The state table for what a thread
// shows is in docs/banneret/agents.md.
import type { OwnCopy, ThreadId } from "@t3tools/contracts";
import type * as Schema from "effect/Schema";

import { notifySignIns } from "./tokens.ts";

/** The company source a thread's MCP entry stands in for. */
export interface CompanyEntry {
  readonly threadId: ThreadId;
  readonly sourceId: string;
  /** The company's own address. The entry itself points at the Hub. */
  readonly url: string;
}

// The entry objects reach both launches unchanged, so the target travels with them without ever being
// part of what a CLI is sent.
const companyEntries = new WeakMap<object, CompanyEntry>();

export const markCompanyEntry = <T extends object>(entry: T, target: CompanyEntry): T => {
  companyEntries.set(entry, target);
  return entry;
};

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};

const marked = (servers: unknown) =>
  Object.entries(record(servers)).flatMap(([key, entry]) => {
    const target = typeof entry === "object" && entry ? companyEntries.get(entry) : undefined;
    return target ? [{ key, entry: entry as Schema.Json, ...target }] : [];
  });

export const hasCompanyEntry = (servers: unknown) => marked(servers)[0];

/** Scheme, host, port and path. A query, a trailing slash or letter case in the host change nothing. */
const address = (value: unknown) => {
  const url = typeof value === "string" ? URL.parse(value) : null;
  return url && (url.protocol === "https:" || url.protocol === "http:")
    ? url.origin + url.pathname.replace(/\/+$/, "")
    : undefined;
};

/** Whether a configured server goes to `sourceUrl`, directly or through a bridge such as `mcp-remote`. */
const reaches = (server: unknown, sourceUrl: string) => {
  const target = address(sourceUrl);
  const { url, args } = record(server);
  return (
    target !== undefined &&
    [url, ...(Array.isArray(args) ? args : [])].some((value) => address(value) === target)
  );
};

/** What happened to the person's copies of one source in one launch. */
export interface FoundCopy {
  readonly sourceId: string;
  /** False when a copy is still on, so the person has to remove it. */
  readonly off: boolean;
}

const found = (sourceId: string, states: ReadonlyArray<boolean>): ReadonlyArray<FoundCopy> =>
  states.length ? [{ sourceId, off: states.every(Boolean) }] : [];

const SERVER_KEY = /^mcp_servers\.([^.]+)$/;

/**
 * Codex's per-thread config with the person's copies switched off. `own` must be what Codex itself read
 * for this launch: Codex refuses to start a thread over a setting for a server it does not have.
 */
export function switchOffInCodex(
  config: Readonly<Record<string, Schema.Json>>,
  own: unknown,
): { config: Record<string, Schema.Json>; copies: ReadonlyArray<FoundCopy> } {
  const servers = record(own);
  /** Every server name the Hub itself sets in this launch. None of them is ever switched off. */
  const hubNames = new Set(Object.keys(config).flatMap((key) => SERVER_KEY.exec(key)?.[1] ?? []));
  const next: Record<string, Schema.Json> = { ...config };
  const copies = marked(config).flatMap(({ key, entry, sourceId, url }) => {
    const states: boolean[] = [];
    const name = SERVER_KEY.exec(key)?.[1] ?? "";
    // Codex merges tables of one name field by field: their token, tool filter or command would land
    // on the Hub's copy. So the Hub's copy takes a free name and theirs is switched off.
    if (Object.hasOwn(servers, name)) {
      let free = `${name}-hub`;
      for (let n = 2; Object.hasOwn(servers, free) || hubNames.has(free); n += 1)
        free = `${name}-hub-${n}`;
      hubNames.add(free);
      delete next[key];
      next[`mcp_servers.${free}`] = entry;
      if (record(servers[name]).enabled !== false) {
        next[`mcp_servers.${name}.enabled`] = false;
        states.push(true);
      }
    }
    for (const [other, server] of Object.entries(servers)) {
      if (hubNames.has(other) || record(server).enabled === false || !reaches(server, url))
        continue;
      // Codex splits an override key on every dot and at the first "=".
      const addressable = !/[.=]/.test(other);
      if (addressable) next[`mcp_servers.${other}.enabled`] = false;
      states.push(addressable);
    }
    return found(sourceId, states);
  });
  return { config: next, copies };
}

/** One server from the person's Claude settings. */
export type OwnServer = readonly [name: string, server: unknown];

const CLAUDE_DENY_NAME = /^[a-zA-Z0-9_-]+$/;
const toggleSlash = (url: string) => (url.endsWith("/") ? url.slice(0, -1) : url + "/");

/**
 * Claude's session settings with a deny list for the person's copies. The company's address is denied
 * whether or not a copy was found, so one the Hub cannot read (a plugin, a claude.ai connector) is off
 * too. The Hub's own entry points at the Hub, so no address here matches it. The list travels on the
 * command line, so it names a found copy and never repeats its command or address.
 */
export function switchOffInClaude<Settings>(
  options: { readonly settings?: Settings; readonly mcpServers?: unknown },
  own: ReadonlyArray<OwnServer>,
): {
  settings: Settings | { deniedMcpServers: unknown[] } | undefined;
  copies: ReadonlyArray<FoundCopy>;
} {
  const entries = marked(options.mcpServers);
  const hubNames = new Set(Object.keys(record(options.mcpServers)));
  // A settings file path cannot take extra keys.
  const settings = typeof options.settings === "string" ? undefined : record(options.settings);
  const denied: Array<{ serverUrl: string } | { serverName: string }> = [];
  const copies = entries.flatMap(({ key, sourceId, url }) => {
    // A `*` is a wildcard in a deny pattern and could shut out unrelated servers.
    const urls = url.includes("*") ? [] : [url, toggleSlash(url)];
    if (settings) denied.push(...urls.map((serverUrl) => ({ serverUrl })));
    const states = own.flatMap(([name, server]) => {
      // Claude takes a session's server over a configured one of the same name, whole.
      if (name === key) return [true];
      if (hubNames.has(name) || !reaches(server, url)) return [];
      if (!settings) return [false];
      if (!CLAUDE_DENY_NAME.test(name)) return [urls.includes(String(record(server).url))];
      denied.push({ serverName: name });
      return [true];
    });
    return found(sourceId, states);
  });
  const before = settings?.deniedMcpServers;
  return {
    settings:
      settings && denied.length
        ? ({
            ...settings,
            deniedMcpServers: [...(Array.isArray(before) ? before : []), ...denied],
          } as { deniedMcpServers: unknown[] })
        : options.settings,
    copies,
  };
}

/** What each thread's latest agent launch did, in memory only. */
const launched = new Map<ThreadId, ReadonlyMap<string, OwnCopy>>();

const same = (a: ReadonlyMap<string, OwnCopy>, b: ReadonlyMap<string, OwnCopy>) =>
  a.size === b.size &&
  [...a].every(([id, copy]) => {
    const other = b.get(id);
    return other?.settings === copy.settings && other.off === copy.off;
  });

const replace = (threadId: ThreadId, next: ReadonlyMap<string, OwnCopy>) => {
  if (same(launched.get(threadId) ?? new Map(), next)) return;
  if (next.size) launched.set(threadId, next);
  else launched.delete(threadId);
  notifySignIns();
};

export const recordLaunch = (
  threadId: ThreadId,
  settings: OwnCopy["settings"],
  copies: ReadonlyArray<FoundCopy>,
) => replace(threadId, new Map(copies.map(({ sourceId, off }) => [sourceId, { settings, off }])));

/** A new agent session is coming, perhaps another provider's: nothing is known until it launches. */
export const forgetLaunch = (threadId: ThreadId) => replace(threadId, new Map());

export const ownCopyOf = (threadId: ThreadId, sourceId: string) =>
  launched.get(threadId)?.get(sourceId);
