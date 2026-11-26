// Banneret Hub: workspaces, named scopes over the projects a person already has. Each environment
// keeps its own copy in a JSON file; clients merge the copies by workspace id (newest wins).
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";

export const BANNERET_WORKSPACES_WS_METHODS = {
  list: "banneretWorkspaces.list",
  put: "banneretWorkspaces.put",
} as const;

/** Only "solo" is creatable; "enterprise" waits for the relay contract (docs/banneret/enterprise.md). */
export const BanneretWorkspaceKind = Schema.Literals(["solo", "enterprise"]);
export type BanneretWorkspaceKind = typeof BanneretWorkspaceKind.Type;

export const BanneretWorkspace = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: BanneretWorkspaceKind,
  /** Stable project identities: `repo:<repository key>` or `path:<environment>:<folder>`. */
  projectKeys: Schema.Array(Schema.String),
  /** ISO time of the last change; the newest copy of a workspace wins. */
  updatedAt: Schema.String,
  /** A tombstone, kept so a merge with an older copy does not bring the workspace back. */
  deleted: Schema.optional(Schema.Boolean),
});
export type BanneretWorkspace = typeof BanneretWorkspace.Type;

export const BanneretWorkspaceList = Schema.Struct({
  workspaces: Schema.Array(BanneretWorkspace),
});
export type BanneretWorkspaceList = typeof BanneretWorkspaceList.Type;

export const WsBanneretWorkspacesListRpc = Rpc.make(BANNERET_WORKSPACES_WS_METHODS.list, {
  payload: Schema.Struct({}),
  success: BanneretWorkspaceList,
  error: EnvironmentAuthorizationError,
});

/** Stores each workspace unless the environment already holds a newer copy of it. */
export const WsBanneretWorkspacesPutRpc = Rpc.make(BANNERET_WORKSPACES_WS_METHODS.put, {
  payload: BanneretWorkspaceList,
  success: BanneretWorkspaceList,
  error: EnvironmentAuthorizationError,
});

const newer = (candidate: BanneretWorkspace, current: BanneretWorkspace) =>
  candidate.updatedAt > current.updatedAt ||
  (candidate.updatedAt === current.updatedAt &&
    JSON.stringify(candidate) > JSON.stringify(current));

/**
 * Merges copies of workspaces by id: the newest `updatedAt` wins, ties broken deterministically so
 * every client converges. Tombstones are kept.
 */
export function mergeBanneretWorkspaces(
  ...lists: ReadonlyArray<ReadonlyArray<BanneretWorkspace>>
): BanneretWorkspace[] {
  const byId = new Map<string, BanneretWorkspace>();
  for (const list of lists) {
    for (const workspace of list) {
      const current = byId.get(workspace.id);
      if (current === undefined || newer(workspace, current)) byId.set(workspace.id, workspace);
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
