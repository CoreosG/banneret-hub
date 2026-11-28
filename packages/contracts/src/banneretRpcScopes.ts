import {
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
} from "./auth.ts";
import { WORKSPACE_FILES_WS_METHODS } from "./workspaceFiles.ts";
import { BANNERET_PORTS_WS_METHODS } from "./banneretPorts.ts";
import { BANNERET_WORKSPACES_WS_METHODS } from "./banneretWorkspaces.ts";
import { BANNERET_RELAY_RPC_SCOPES } from "./banneretRelay.ts";

export const banneretRpcScopes = {
  [WORKSPACE_FILES_WS_METHODS.move]: AuthFilesystemWriteScope,
  [WORKSPACE_FILES_WS_METHODS.delete]: AuthFilesystemWriteScope,
  [WORKSPACE_FILES_WS_METHODS.makeDirectory]: AuthFilesystemWriteScope,
  [WORKSPACE_FILES_WS_METHODS.createUploadUrl]: AuthFilesystemWriteScope,
  [WORKSPACE_FILES_WS_METHODS.createDownloadUrl]: AuthFilesystemReadScope,
  [BANNERET_PORTS_WS_METHODS.list]: AuthOrchestrationReadScope,
  [BANNERET_WORKSPACES_WS_METHODS.list]: AuthOrchestrationReadScope,
  [BANNERET_WORKSPACES_WS_METHODS.put]: AuthOrchestrationOperateScope,
  ...BANNERET_RELAY_RPC_SCOPES,
  "banneretPause.status": AuthOrchestrationReadScope,
  "banneretPause.change": AuthOrchestrationOperateScope,
} as const;
