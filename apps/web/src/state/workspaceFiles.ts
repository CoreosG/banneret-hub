import { createWorkspaceFilesAtoms } from "@t3tools/client-runtime/state/workspace-files";

import { connectionAtomRuntime } from "../connection/runtime";

/** Banneret Hub: file-explorer operations against a workspace on any connected environment. */
export const workspaceFilesEnvironment = createWorkspaceFilesAtoms(connectionAtomRuntime);
