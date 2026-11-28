import { BANNERET_RELAY_RPC_AGGREGATES } from "@t3tools/contracts";

export const rpcAggregates = {
  "workspaceFiles.move": "workspace",
  "workspaceFiles.delete": "workspace",
  "workspaceFiles.makeDirectory": "workspace",
  "workspaceFiles.createUploadUrl": "workspace",
  "workspaceFiles.createDownloadUrl": "workspace",
  "banneretPorts.list": "preview",
  "banneretWorkspaces.list": "orchestration",
  "banneretWorkspaces.put": "orchestration",
  ...BANNERET_RELAY_RPC_AGGREGATES,
  "banneretPause.status": "orchestration",
  "banneretPause.change": "orchestration",
} as const;
