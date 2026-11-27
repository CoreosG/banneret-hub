import {
  WsWorkspaceFilesCreateDownloadUrlRpc,
  WsWorkspaceFilesCreateUploadUrlRpc,
  WsWorkspaceFilesDeleteRpc,
  WsWorkspaceFilesMakeDirectoryRpc,
  WsWorkspaceFilesMoveRpc,
} from "./workspaceFiles.ts";
import { WsBanneretPortsListRpc } from "./banneretPorts.ts";
import { WsBanneretWorkspacesListRpc, WsBanneretWorkspacesPutRpc } from "./banneretWorkspaces.ts";
import { BANNERET_RELAY_RPCS } from "./banneretRelay.ts";
import { pauseRpcs } from "./banneretPause.ts";
export const banneretRpcs = [
  WsWorkspaceFilesMoveRpc,
  WsWorkspaceFilesDeleteRpc,
  WsWorkspaceFilesMakeDirectoryRpc,
  WsWorkspaceFilesCreateUploadUrlRpc,
  WsWorkspaceFilesCreateDownloadUrlRpc,
  WsBanneretPortsListRpc,
  WsBanneretWorkspacesListRpc,
  WsBanneretWorkspacesPutRpc,
  ...BANNERET_RELAY_RPCS,
  ...pauseRpcs,
] as const;
