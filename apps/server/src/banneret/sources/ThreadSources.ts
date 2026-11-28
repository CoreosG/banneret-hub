// Banneret Hub: a company's `co-<source>` MCP servers in a thread, behind the local plugin proxy. The
// Hub connects to them itself, never through the relay. One state per (thread, source), in memory only,
// changed by `transition` alone; the state table is in docs/banneret/agents.md. In `sign_in_needed` and
// `failed` the Hub leaves the source alone until the next turn, so there is one try per turn.
import type { RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { companySources, readSavedOwnership, type CompanySource } from "./ownership.ts";

export type SourceState =
  | { readonly state: "configured" }
  | { readonly state: "sign_in_needed" }
  | { readonly state: "connecting" }
  | { readonly state: "connected" }
  | { readonly state: "failed"; readonly reason: string };

export type SourceEvent =
  | { readonly type: "turn_changed" }
  | { readonly type: "credential"; readonly present: boolean }
  | { readonly type: "listed"; readonly missing: ReadonlyArray<string> }
  | { readonly type: "unauthorized" }
  | { readonly type: "unreachable" };

export const configured: SourceState = { state: "configured" };

export function transition(from: SourceState, event: SourceEvent): SourceState {
  const open = from.state === "connecting" || from.state === "connected";
  switch (event.type) {
    case "turn_changed":
      return configured;
    case "credential":
      // A sign-in that goes away closes the source at once. One that arrives waits for the next turn.
      if (!event.present) return from.state === "failed" ? from : { state: "sign_in_needed" };
      return from.state === "configured" ? { state: "connecting" } : from;
    case "listed":
      if (!open) return from;
      return event.missing.length
        ? { state: "failed", reason: `shape_missing: ${event.missing.join(", ")}` }
        : { state: "connected" };
    case "unauthorized":
      return open ? { state: "sign_in_needed" } : from;
    case "unreachable":
      return from.state === "connecting" ? { state: "failed", reason: "unreachable" } : from;
  }
}

/** The plain message a thread gets while a source cannot be used; undefined while it can. */
export const sourceNotice = (title: string, auth: CompanySource["auth"], state: SourceState) =>
  state.state === "sign_in_needed"
    ? auth === "none"
      ? `${title} did not accept this machine on your company network. Tell your person.`
      : `${title} needs your person to sign in. Tell them to sign in to it in Banneret Hub, under Settings, Chat, Company servers. Try again in your next turn. If its tools are still missing, they can start a new chat.`
    : state.state === "failed"
      ? `${title} is unavailable in this chat (${state.reason}). A new chat tries again. Tell your person, and do not use another tool in its place.`
      : undefined;

export interface SourceSlot {
  readonly state: () => SourceState;
  readonly apply: (event: SourceEvent) => SourceState;
}

export const makeSourceStates = () => {
  const states = new Map<string, { identity: string; state: SourceState }>();
  return (
    threadId: ThreadId,
    source: CompanySource,
    run: RunId | null,
    credentialPresent: boolean,
  ): SourceSlot => {
    const key = JSON.stringify([threadId, source.id]);
    const identity = JSON.stringify([run, source.url, source.owns]);
    let entry = states.get(key);
    if (!entry || entry.identity !== identity) {
      const state = entry ? transition(entry.state, { type: "turn_changed" }) : configured;
      entry = { identity, state };
      states.set(key, entry);
    }
    const slot = entry;
    slot.state = transition(slot.state, { type: "credential", present: credentialPresent });
    return {
      state: () => slot.state,
      apply: (event) => (slot.state = transition(slot.state, event)),
    };
  };
};

/**
 * A company source in the shape the plugin proxy, tool levels and approvals already read. It carries
 * no token: `sourceAccess` (tokens.ts) reads the person's own one when a request is sent.
 */
const threadSource = (source: CompanySource, relayOrigin: string) => ({
  company: source,
  relayOrigin,
  endpoint: source.url,
  manifest: {
    source: `co-${source.id}`,
    description: source.title,
    auth: source.auth === "none" ? ("service" as const) : ("per-user-token" as const),
    capabilities: source.owns,
    toolPrefix: source.prefix,
  },
});
export type ThreadSource = ReturnType<typeof threadSource>;

/** The company sources of a relay's workspace, from the owners last read from that relay. */
export const sourcesFor = Effect.fn("BanneretSources.forRelay")(function* (relayOrigin: string) {
  const saved = yield* readSavedOwnership(relayOrigin);
  return saved ? companySources(saved).map((source) => threadSource(source, relayOrigin)) : [];
});
