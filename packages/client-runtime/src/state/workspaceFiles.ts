// Banneret Hub: file-explorer commands (move, rename, delete, new folder, transfer URLs).
import { WORKSPACE_FILES_WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createAtomCommandScheduler, createEnvironmentRpcCommand } from "./runtime.ts";

export function createWorkspaceFilesAtoms<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, ER>,
) {
  // One workspace's mutations run in order, so a move cannot race the delete queued after it.
  const scheduler = createAtomCommandScheduler();
  const byWorkspace = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { cwd: string } }) =>
      `${environmentId}\u0000${input.cwd}`,
  };
  return {
    move: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workspace-files:move",
      tag: WORKSPACE_FILES_WS_METHODS.move,
      scheduler,
      concurrency: byWorkspace,
    }),
    delete: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workspace-files:delete",
      tag: WORKSPACE_FILES_WS_METHODS.delete,
      scheduler,
      concurrency: byWorkspace,
    }),
    makeDirectory: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workspace-files:make-directory",
      tag: WORKSPACE_FILES_WS_METHODS.makeDirectory,
      scheduler,
      concurrency: byWorkspace,
    }),
    createUploadUrl: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workspace-files:create-upload-url",
      tag: WORKSPACE_FILES_WS_METHODS.createUploadUrl,
    }),
    createDownloadUrl: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workspace-files:create-download-url",
      tag: WORKSPACE_FILES_WS_METHODS.createDownloadUrl,
    }),
  };
}
