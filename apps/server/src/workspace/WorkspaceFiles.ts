// @effect-diagnostics nodeBuiltinImport:off -- rename, link, streaming zip and exclusive publish are filesystem boundaries missing from Effect's API.
// Banneret Hub: file-explorer operations. Every path goes through WorkspaceFileSystem's write guard
// (known workspace, inside the real root, never in .git), at signing time and again at use.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeZlib from "node:zlib";

import {
  WORKSPACE_FILES_DOWNLOAD_ROUTE_PREFIX,
  WORKSPACE_FILES_UPLOAD_ROUTE_PREFIX,
  WORKSPACE_FILES_URL_TTL_MS,
  WORKSPACE_FILES_WS_METHODS,
  type WorkspaceFilesCreateDownloadUrlInput,
  type WorkspaceFilesCreateUploadUrlInput,
  WorkspaceFilesError,
  type WorkspaceFilesFailure,
  type WorkspaceFilesMoveInput,
  type WorkspaceFilesPathInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as AssetSigner from "../assets/AssetSigner.ts";
import { base64UrlDecodeUtf8, base64UrlEncode } from "../auth/utils.ts";
import { requestUrl } from "../requestUrl.ts";
import type { UnknownWorkspaceError } from "./KnownWorkspaces.ts";
import type { WorkspacePathOutsideRootError } from "./WorkspacePaths.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./WorkspaceFileSystem.ts";

export interface WorkspaceWriteGuard {
  /** Banneret Hub: the write guard alone, for file-explorer operations. */
  readonly resolveWritablePath: (input: {
    readonly cwd: string;
    readonly relativePath: string;
  }) => Effect.Effect<
    { readonly relativePath: string; readonly realTargetPath: string },
    | WorkspaceFileSystem.WorkspaceFileSystemError
    | WorkspacePathOutsideRootError
    | UnknownWorkspaceError
  >;
}

const filesError = (failure: WorkspaceFilesFailure, message: string) =>
  new WorkspaceFilesError({ failure, message });

const fromGuardError = (cause: { readonly _tag: string; readonly message: string }) =>
  cause._tag === "WorkspaceFilePathEscapeError" ||
  cause._tag === "WorkspacePathOutsideRootError" ||
  cause._tag === "UnknownWorkspaceError"
    ? filesError("outside_workspace", cause.message)
    : filesError("failed", cause.message);

const ioError = (message: string) => (cause: unknown) => {
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EEXIST" || code === "ENOTEMPTY") return filesError("exists", message);
  if (code === "ENOENT") return filesError("not_found", message);
  return filesError("failed", `${message} ${cause instanceof Error ? cause.message : ""}`.trim());
};

const io = <A>(message: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: ioError(message) });

/** `/`-separated, no leading/trailing slashes, no `.`/`..` segments. Empty means the root. */
function normalizeRelative(relativePath: string): string | null {
  const segments = relativePath.replaceAll("\\", "/").split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  return segments.join("/");
}

const lstatOrNull = (target: string) => NodeFSP.lstat(target).catch(() => null);

/** Absolute path of an entry itself (a symlink is not followed), after the guard accepts it. */
const resolveEntry = Effect.fn("WorkspaceFiles.resolveEntry")(function* (
  cwd: string,
  relativePath: string,
) {
  const normalized = normalizeRelative(relativePath);
  if (!normalized) return yield* filesError("invalid", `'${relativePath}' is not a file path.`);
  const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
  const guarded = yield* workspaceFileSystem
    .resolveWritablePath({ cwd, relativePath: normalized })
    .pipe(Effect.mapError(fromGuardError));
  const parent = NodePath.posix.dirname(normalized);
  const realParent =
    parent === "."
      ? yield* io("Cannot resolve the workspace folder.", () =>
          NodeFSP.realpath(NodePath.resolve(cwd)),
        )
      : (yield* workspaceFileSystem
          .resolveWritablePath({ cwd, relativePath: parent })
          .pipe(Effect.mapError(fromGuardError))).realTargetPath;
  return {
    relativePath: guarded.relativePath,
    absolutePath: NodePath.join(realParent, NodePath.posix.basename(normalized)),
  };
});

const refreshEntries = (cwd: string) =>
  WorkspaceEntries.WorkspaceEntries.pipe(Effect.flatMap((entries) => entries.refresh(cwd)));

const move = Effect.fn("WorkspaceFiles.move")(function* (input: WorkspaceFilesMoveInput) {
  const source = yield* resolveEntry(input.cwd, input.fromPath);
  const destination = yield* resolveEntry(input.cwd, input.toPath);
  const sourceStat = yield* Effect.promise(() => lstatOrNull(source.absolutePath));
  if (!sourceStat) return yield* filesError("not_found", `'${input.fromPath}' no longer exists.`);
  if (
    destination.absolutePath === source.absolutePath ||
    destination.absolutePath.startsWith(source.absolutePath + NodePath.sep)
  ) {
    return yield* filesError("invalid", `Cannot move '${input.fromPath}' into itself.`);
  }
  const destinationStat = yield* Effect.promise(() => lstatOrNull(destination.absolutePath));
  // A case-only rename on a case-insensitive disk names the same entry.
  const sameEntry =
    destinationStat !== null &&
    destinationStat.ino === sourceStat.ino &&
    destinationStat.dev === sourceStat.dev;
  if (destinationStat && !sameEntry) {
    return yield* filesError("exists", `'${input.toPath}' already exists.`);
  }
  const message = `Cannot move '${input.fromPath}' to '${input.toPath}'.`;
  yield* io(message, async () => {
    await NodeFSP.mkdir(NodePath.dirname(destination.absolutePath), { recursive: true });
    try {
      await NodeFSP.rename(source.absolutePath, destination.absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      await NodeFSP.cp(source.absolutePath, destination.absolutePath, {
        recursive: true,
        errorOnExist: true,
        force: false,
        verbatimSymlinks: true,
      });
      await NodeFSP.rm(source.absolutePath, { recursive: true });
    }
  });
  yield* refreshEntries(input.cwd);
  return { relativePath: destination.relativePath };
});

const deleteEntry = Effect.fn("WorkspaceFiles.delete")(function* (input: WorkspaceFilesPathInput) {
  const entry = yield* resolveEntry(input.cwd, input.relativePath);
  if (!(yield* Effect.promise(() => lstatOrNull(entry.absolutePath)))) {
    return yield* filesError("not_found", `'${input.relativePath}' no longer exists.`);
  }
  yield* io(`Cannot delete '${input.relativePath}'.`, () =>
    NodeFSP.rm(entry.absolutePath, { recursive: true }),
  );
  yield* refreshEntries(input.cwd);
  return { relativePath: entry.relativePath };
});

const makeDirectory = Effect.fn("WorkspaceFiles.makeDirectory")(function* (
  input: WorkspaceFilesPathInput,
) {
  const entry = yield* resolveEntry(input.cwd, input.relativePath);
  if (yield* Effect.promise(() => lstatOrNull(entry.absolutePath))) {
    return yield* filesError("exists", `'${input.relativePath}' already exists.`);
  }
  yield* io(`Cannot create folder '${input.relativePath}'.`, () =>
    NodeFSP.mkdir(entry.absolutePath, { recursive: true }),
  );
  yield* refreshEntries(input.cwd);
  return { relativePath: entry.relativePath };
});

const UploadClaims = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("workspace-files-upload"),
  cwd: Schema.String,
  relativePath: Schema.String,
  sizeBytes: Schema.Number,
  overwrite: Schema.Boolean,
  expiresAt: Schema.Number,
});
type UploadClaims = typeof UploadClaims.Type;

const DownloadClaims = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("workspace-files-download"),
  cwd: Schema.String,
  relativePath: Schema.String,
  expiresAt: Schema.Number,
});
type DownloadClaims = typeof DownloadClaims.Type;

const sign = Effect.fn("WorkspaceFiles.sign")(function* (
  prefix: string,
  claimsJson: string,
  fileName: string,
  expiresAt: number,
) {
  const payload = base64UrlEncode(claimsJson);
  const signer = yield* AssetSigner.AssetSigner;
  const signature = yield* signer
    .sign(payload)
    .pipe(Effect.mapError(() => filesError("failed", "Cannot sign the transfer URL.")));
  const suffix =
    prefix === WORKSPACE_FILES_DOWNLOAD_ROUTE_PREFIX ? `/${encodeURIComponent(fileName)}` : "";
  return { relativeUrl: `${prefix}/${payload}.${signature}${suffix}`, fileName, expiresAt };
});

const uploadClaimsJson = Schema.fromJsonString(UploadClaims);
const downloadClaimsJson = Schema.fromJsonString(DownloadClaims);
const encodeUploadClaims = Schema.encodeSync(uploadClaimsJson);
const encodeDownloadClaims = Schema.encodeSync(downloadClaimsJson);
const decodeUploadClaims = Schema.decodeOption(uploadClaimsJson);
const decodeDownloadClaims = Schema.decodeOption(downloadClaimsJson);

const verify = Effect.fn("WorkspaceFiles.verify")(function* <A extends { expiresAt: number }>(
  decode: (json: string) => Option.Option<A>,
  token: string,
) {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const signer = yield* AssetSigner.AssetSigner;
  const valid = yield* signer.verify(payload, signature).pipe(Effect.orElseSucceed(() => false));
  if (!valid) return null;
  const claims = Option.getOrNull(
    yield* Effect.try({
      try: () => base64UrlDecodeUtf8(payload),
      catch: () => filesError("invalid", "Malformed transfer URL."),
    }).pipe(
      Effect.map(decode),
      Effect.orElseSucceed(() => Option.none<A>()),
    ),
  );
  return claims && claims.expiresAt > (yield* Clock.currentTimeMillis) ? claims : null;
});

const createUploadUrl = Effect.fn("WorkspaceFiles.createUploadUrl")(function* (
  input: WorkspaceFilesCreateUploadUrlInput,
) {
  const entry = yield* resolveEntry(input.cwd, input.relativePath);
  const existing = yield* Effect.promise(() => lstatOrNull(entry.absolutePath));
  if (existing && (existing.isDirectory() || !input.overwrite)) {
    return yield* filesError("exists", `'${input.relativePath}' already exists.`);
  }
  const expiresAt = (yield* Clock.currentTimeMillis) + WORKSPACE_FILES_URL_TTL_MS;
  const claims: UploadClaims = {
    version: 1,
    kind: "workspace-files-upload",
    cwd: input.cwd,
    relativePath: entry.relativePath,
    sizeBytes: input.sizeBytes,
    overwrite: input.overwrite,
    expiresAt,
  };
  return yield* sign(
    WORKSPACE_FILES_UPLOAD_ROUTE_PREFIX,
    encodeUploadClaims(claims),
    NodePath.posix.basename(entry.relativePath),
    expiresAt,
  );
});

const resolveDownload = Effect.fn("WorkspaceFiles.resolveDownload")(function* (
  cwd: string,
  relativePath: string,
) {
  const normalized = normalizeRelative(relativePath);
  if (normalized === null) return yield* filesError("invalid", `'${relativePath}' is invalid.`);
  if (normalized === "") {
    // The root itself: the guard runs on a child name to confirm the workspace is known.
    yield* resolveEntry(cwd, "banneret-root-probe");
    const absolutePath = yield* io("Cannot resolve the workspace folder.", () =>
      NodeFSP.realpath(NodePath.resolve(cwd)),
    );
    return { relativePath: "", absolutePath, name: NodePath.basename(absolutePath) };
  }
  const entry = yield* resolveEntry(cwd, normalized);
  return { ...entry, name: NodePath.posix.basename(normalized) };
});

const createDownloadUrl = Effect.fn("WorkspaceFiles.createDownloadUrl")(function* (
  input: WorkspaceFilesCreateDownloadUrlInput,
) {
  const entry = yield* resolveDownload(input.cwd, input.relativePath);
  const info = yield* io(`'${input.relativePath}' no longer exists.`, () =>
    NodeFSP.stat(entry.absolutePath),
  );
  const expiresAt = (yield* Clock.currentTimeMillis) + WORKSPACE_FILES_URL_TTL_MS;
  const claims: DownloadClaims = {
    version: 1,
    kind: "workspace-files-download",
    cwd: input.cwd,
    relativePath: entry.relativePath,
    expiresAt,
  };
  return yield* sign(
    WORKSPACE_FILES_DOWNLOAD_ROUTE_PREFIX,
    encodeDownloadClaims(claims),
    info.isDirectory() ? `${entry.name}.zip` : entry.name,
    expiresAt,
  );
});

/** Handlers for the `workspaceFiles.*` RPCs, spread into the WebSocket handler group. */
export const rpcHandlers = {
  [WORKSPACE_FILES_WS_METHODS.move]: move,
  [WORKSPACE_FILES_WS_METHODS.delete]: deleteEntry,
  [WORKSPACE_FILES_WS_METHODS.makeDirectory]: makeDirectory,
  [WORKSPACE_FILES_WS_METHODS.createUploadUrl]: createUploadUrl,
  [WORKSPACE_FILES_WS_METHODS.createDownloadUrl]: createDownloadUrl,
};

const SIGNED_URL_ROUTE_OPTIONS = { redactedParams: ["*"] };
const noStore = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };

const tokenAfter = (request: HttpServerRequest.HttpServerRequest, prefix: string) => {
  const url = requestUrl(request);
  if (Option.isNone(url)) return null;
  const rest = url.value.pathname.slice(`${prefix}/`.length);
  return rest.split("/")[0] || null;
};

const storeUpload = Effect.fn("WorkspaceFiles.storeUpload")(function* (
  claims: UploadClaims,
  body: HttpServerRequest.HttpServerRequest["stream"],
) {
  const entry = yield* resolveEntry(claims.cwd, claims.relativePath);
  const directory = NodePath.dirname(entry.absolutePath);
  const partPath = NodePath.join(
    directory,
    `.${NodePath.basename(entry.absolutePath)}.${NodeCrypto.randomUUID()}.banneret-upload`,
  );
  const fileSystem = yield* FileSystem.FileSystem;
  let received = 0;
  return yield* Effect.gen(function* () {
    yield* io("Cannot create the destination folder.", () =>
      NodeFSP.mkdir(directory, { recursive: true }),
    );
    yield* Stream.run(
      body.pipe(
        Stream.takeWhile((chunk) => {
          received += chunk.byteLength;
          return received <= claims.sizeBytes;
        }),
      ),
      fileSystem.sink(partPath),
    ).pipe(Effect.mapError((cause) => filesError("failed", `Upload failed: ${cause.message}`)));
    if (received !== claims.sizeBytes) {
      return yield* filesError("invalid", `Received ${received} of ${claims.sizeBytes} bytes.`);
    }
    yield* io(`'${claims.relativePath}' already exists.`, async () => {
      if (claims.overwrite) {
        if ((await lstatOrNull(entry.absolutePath))?.isDirectory()) {
          throw Object.assign(new Error("A folder has this name."), { code: "EEXIST" });
        }
        await NodeFSP.rename(partPath, entry.absolutePath);
        return;
      }
      try {
        await NodeFSP.link(partPath, entry.absolutePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw error;
        // Some filesystems (FAT, network shares) refuse hard links.
        await NodeFSP.copyFile(partPath, entry.absolutePath, NodeFSP.constants.COPYFILE_EXCL);
      }
    });
  }).pipe(Effect.ensuring(Effect.promise(() => NodeFSP.rm(partPath, { force: true }))));
});

const statusOf = (error: WorkspaceFilesError) =>
  error.failure === "exists"
    ? 409
    : error.failure === "not_found"
      ? 404
      : error.failure === "failed"
        ? 500
        : 400;

export const layerUploadRoute = HttpRouter.add(
  "POST",
  `${WORKSPACE_FILES_UPLOAD_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const token = tokenAfter(request, WORKSPACE_FILES_UPLOAD_ROUTE_PREFIX);
    const claims = token ? yield* verify(decodeUploadClaims, token) : null;
    if (!claims) return HttpServerResponse.text("Not Found", { status: 404 });
    const contentLength = request.headers["content-length"];
    if (contentLength !== undefined && Number(contentLength) !== claims.sizeBytes) {
      return HttpServerResponse.text("Content-Length must match the upload size.", { status: 400 });
    }
    // Keep the request stream in the route scope until the response is sent.
    const bodyPull = yield* Stream.toPull(request.stream);
    return yield* storeUpload(claims, Stream.fromPull(Effect.succeed(bodyPull))).pipe(
      Effect.as(HttpServerResponse.empty({ status: 204, headers: noStore })),
      Effect.catchTags({
        WorkspaceFilesError: (error) =>
          Effect.succeed(
            HttpServerResponse.text(error.message, { status: statusOf(error), headers: noStore }),
          ),
      }),
    );
  }),
  SIGNED_URL_ROUTE_OPTIONS,
);

function contentDisposition(fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

interface ZipSource {
  readonly name: string;
  readonly absolutePath: string | null;
  readonly modified: Date;
}

const ZIP_MAX_ENTRIES = 65_535;
const ZIP_MAX_BYTES = 0xffff_0000;

const isGitMetadataName = (name: string) => {
  const upper = name.replace(/[. ]+$/, "").toUpperCase();
  return upper === ".GIT" || upper === "GIT~1";
};

/** Regular files and folders under `root`; symlinks and .git are skipped, so nothing escapes. */
async function collectZipSources(root: string, rootName: string, rootModified: Date) {
  const sources: ZipSource[] = [];
  let totalBytes = 0;
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const entries = await NodeFSP.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (isGitMetadataName(entry.name) || entry.isSymbolicLink()) continue;
      const absolutePath = NodePath.join(directory, entry.name);
      const name = `${prefix}${entry.name}`;
      const info = await NodeFSP.lstat(absolutePath);
      if (info.isDirectory()) {
        sources.push({ name: `${name}/`, absolutePath: null, modified: info.mtime });
        await walk(absolutePath, `${name}/`);
      } else if (info.isFile()) {
        sources.push({ name, absolutePath, modified: info.mtime });
        totalBytes += info.size + 2 * (Buffer.byteLength(name) + 100);
      }
      if (sources.length > ZIP_MAX_ENTRIES || totalBytes > ZIP_MAX_BYTES) {
        throw Object.assign(new Error("Folder too large to zip (over 4 GB or 65,535 entries)."), {
          code: "ETOOBIG",
        });
      }
    }
  };
  sources.push({ name: `${rootName}/`, absolutePath: null, modified: rootModified });
  await walk(root, `${rootName}/`);
  return sources;
}

function dosDateTime(date: Date) {
  const year = Math.max(date.getFullYear(), 1980);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Streams a zip (deflate, data descriptors, UTF-8 names) without buffering whole files. */
async function* zipStream(sources: readonly ZipSource[]): AsyncGenerator<Uint8Array> {
  const central: Buffer[] = [];
  let offset = 0;
  for (const source of sources) {
    const name = Buffer.from(source.name, "utf8");
    const isFile = source.absolutePath !== null;
    const flags = 0x0800 | (isFile ? 0x0008 : 0);
    const method = isFile ? 8 : 0;
    const { time, date } = dosDateTime(source.modified);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt16LE(name.length, 26);
    yield local;
    yield name;
    const headerOffset = offset;
    offset += local.length + name.length;
    let crc = 0;
    let compressed = 0;
    let uncompressed = 0;
    if (source.absolutePath !== null) {
      const input = NodeFS.createReadStream(source.absolutePath);
      const deflate = NodeZlib.createDeflateRaw({ level: 6 });
      input.on("data", (chunk) => {
        const bytes = chunk as Buffer;
        crc = NodeZlib.crc32(bytes, crc);
        uncompressed += bytes.length;
      });
      NodeStream.pipeline(input, deflate, () => {});
      for await (const chunk of deflate) {
        compressed += (chunk as Buffer).length;
        yield chunk as Buffer;
      }
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc >>> 0, 4);
      descriptor.writeUInt32LE(compressed, 8);
      descriptor.writeUInt32LE(uncompressed, 12);
      yield descriptor;
      offset += compressed + descriptor.length;
    }
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(0x0314, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(date, 14);
    header.writeUInt32LE(crc >>> 0, 16);
    header.writeUInt32LE(compressed, 20);
    header.writeUInt32LE(uncompressed, 24);
    header.writeUInt16LE(name.length, 28);
    // Unix mode in the high bits keeps folders as folders on every unzip tool.
    header.writeUInt32LE((((isFile ? 0o100644 : 0o040755) << 16) | (isFile ? 0 : 0x10)) >>> 0, 38);
    header.writeUInt32LE(headerOffset, 42);
    central.push(header, name);
  }
  const centralDirectory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(sources.length, 8);
  end.writeUInt16LE(sources.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  yield centralDirectory;
  yield end;
}

const downloadResponse = Effect.fn("WorkspaceFiles.downloadResponse")(function* (
  claims: DownloadClaims,
) {
  const entry = yield* resolveDownload(claims.cwd, claims.relativePath);
  const info = yield* io(`'${claims.relativePath}' no longer exists.`, () =>
    NodeFSP.stat(entry.absolutePath),
  );
  if (info.isFile()) {
    return HttpServerResponse.stream(
      Stream.fromAsyncIterable(NodeFS.createReadStream(entry.absolutePath), (cause) =>
        filesError("failed", String(cause)),
      ),
      {
        contentType: "application/octet-stream",
        headers: {
          ...noStore,
          "content-length": String(info.size),
          "content-disposition": contentDisposition(entry.name),
        },
      },
    );
  }
  const sources = yield* io(`Cannot zip '${claims.relativePath || entry.name}'.`, () =>
    collectZipSources(entry.absolutePath, entry.name, info.mtime),
  );
  return HttpServerResponse.stream(
    Stream.fromAsyncIterable(zipStream(sources), (cause) => filesError("failed", String(cause))),
    {
      contentType: "application/zip",
      headers: { ...noStore, "content-disposition": contentDisposition(`${entry.name}.zip`) },
    },
  );
});

export const layerDownloadRoute = HttpRouter.add(
  "GET",
  `${WORKSPACE_FILES_DOWNLOAD_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const token = tokenAfter(request, WORKSPACE_FILES_DOWNLOAD_ROUTE_PREFIX);
    const claims = token ? yield* verify(decodeDownloadClaims, token) : null;
    if (!claims) return HttpServerResponse.text("Not Found", { status: 404 });
    return yield* downloadResponse(claims).pipe(
      Effect.catchTags({
        WorkspaceFilesError: (error) =>
          Effect.succeed(
            HttpServerResponse.text(error.message, { status: statusOf(error), headers: noStore }),
          ),
      }),
    );
  }),
  SIGNED_URL_ROUTE_OPTIONS,
);
