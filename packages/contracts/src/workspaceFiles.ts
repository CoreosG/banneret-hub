// Banneret Hub: file-explorer operations (move, rename, delete, new folder, upload, download).
// Paths are workspace-relative and `/`-separated; the server confines them to the workspace.
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const WORKSPACE_FILES_WS_METHODS = {
  move: "workspaceFiles.move",
  delete: "workspaceFiles.delete",
  makeDirectory: "workspaceFiles.makeDirectory",
  createUploadUrl: "workspaceFiles.createUploadUrl",
  createDownloadUrl: "workspaceFiles.createDownloadUrl",
} as const;

export const WORKSPACE_FILES_UPLOAD_ROUTE_PREFIX = "/api/workspace-files/upload";
export const WORKSPACE_FILES_DOWNLOAD_ROUTE_PREFIX = "/api/workspace-files/download";
export const WORKSPACE_FILES_URL_TTL_MS = 10 * 60_000;
const WORKSPACE_FILES_UPLOAD_MAX_BYTES = 16 * 1024 ** 3;

const WorkspaceRelativePath = Schema.NonEmptyString.check(Schema.isMaxLength(1024));

export const WorkspaceFilesMoveInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  fromPath: WorkspaceRelativePath,
  toPath: WorkspaceRelativePath,
});
export type WorkspaceFilesMoveInput = typeof WorkspaceFilesMoveInput.Type;

export const WorkspaceFilesPathInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: WorkspaceRelativePath,
});
export type WorkspaceFilesPathInput = typeof WorkspaceFilesPathInput.Type;

export const WorkspaceFilesPathResult = Schema.Struct({
  relativePath: Schema.String,
});
export type WorkspaceFilesPathResult = typeof WorkspaceFilesPathResult.Type;

export const WorkspaceFilesCreateUploadUrlInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: WorkspaceRelativePath,
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(WORKSPACE_FILES_UPLOAD_MAX_BYTES)),
  /** Replace an existing file; otherwise the upload fails when the path exists. */
  overwrite: Schema.Boolean,
});
export type WorkspaceFilesCreateUploadUrlInput = typeof WorkspaceFilesCreateUploadUrlInput.Type;

/** `relativePath` may be empty to name the workspace root (downloads only). */
export const WorkspaceFilesCreateDownloadUrlInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: Schema.String.check(Schema.isMaxLength(1024)),
});
export type WorkspaceFilesCreateDownloadUrlInput = typeof WorkspaceFilesCreateDownloadUrlInput.Type;

export const WorkspaceFilesSignedUrlResult = Schema.Struct({
  relativeUrl: Schema.String,
  fileName: Schema.String,
  expiresAt: Schema.Number,
});
export type WorkspaceFilesSignedUrlResult = typeof WorkspaceFilesSignedUrlResult.Type;

export const WorkspaceFilesFailure = Schema.Literals([
  "exists",
  "not_found",
  "outside_workspace",
  "invalid",
  "failed",
]);
export type WorkspaceFilesFailure = typeof WorkspaceFilesFailure.Type;

export class WorkspaceFilesError extends Schema.TaggedError<WorkspaceFilesError>()(
  "WorkspaceFilesError",
  {
    failure: WorkspaceFilesFailure,
    message: Schema.String,
  },
) {}

const errors = Schema.Union([WorkspaceFilesError, EnvironmentAuthorizationError]);

export const WsWorkspaceFilesMoveRpc = Rpc.make(WORKSPACE_FILES_WS_METHODS.move, {
  payload: WorkspaceFilesMoveInput,
  success: WorkspaceFilesPathResult,
  error: errors,
});

export const WsWorkspaceFilesDeleteRpc = Rpc.make(WORKSPACE_FILES_WS_METHODS.delete, {
  payload: WorkspaceFilesPathInput,
  success: WorkspaceFilesPathResult,
  error: errors,
});

export const WsWorkspaceFilesMakeDirectoryRpc = Rpc.make(WORKSPACE_FILES_WS_METHODS.makeDirectory, {
  payload: WorkspaceFilesPathInput,
  success: WorkspaceFilesPathResult,
  error: errors,
});

export const WsWorkspaceFilesCreateUploadUrlRpc = Rpc.make(
  WORKSPACE_FILES_WS_METHODS.createUploadUrl,
  {
    payload: WorkspaceFilesCreateUploadUrlInput,
    success: WorkspaceFilesSignedUrlResult,
    error: errors,
  },
);

export const WsWorkspaceFilesCreateDownloadUrlRpc = Rpc.make(
  WORKSPACE_FILES_WS_METHODS.createDownloadUrl,
  {
    payload: WorkspaceFilesCreateDownloadUrlInput,
    success: WorkspaceFilesSignedUrlResult,
    error: errors,
  },
);
