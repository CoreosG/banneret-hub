// Banneret Hub: uploads into and downloads from a workspace over signed HTTP URLs, so transfers
// stream on every connection (local, LAN, Tailscale) instead of riding the WebSocket.
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, WorkspaceFilesSignedUrlResult } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";

import { isElectron } from "~/env";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readPreparedConnection } from "~/state/session";
import { workspaceFilesEnvironment } from "~/state/workspaceFiles";

export interface DroppedFile {
  /** Path below the drop target, `/`-separated. */
  readonly relativePath: string;
  readonly file: File;
}

export type ConflictChoice = "replace" | "keep-both" | "skip";

type WorkspaceFilesCommands = typeof workspaceFilesEnvironment;
type CommandInput<K extends keyof WorkspaceFilesCommands> = Parameters<
  WorkspaceFilesCommands[K]["run"]
>[1]["input"];

export class WorkspaceFilesFailure extends Schema.TaggedError<WorkspaceFilesFailure>()(
  "WorkspaceFilesFailure",
  { message: Schema.String, failure: Schema.optional(Schema.String) },
) {}

const isWorkspaceFilesFailure = Schema.is(WorkspaceFilesFailure);
const isExistsFailure = (error: unknown) =>
  isWorkspaceFilesFailure(error) && error.failure === "exists";

const failure = (message: string, kind?: string) =>
  new WorkspaceFilesFailure({ message, ...(kind === undefined ? {} : { failure: kind }) });

/** Runs a workspaceFiles command and rethrows its failure with the server's message. */
export async function runWorkspaceFilesCommand<K extends keyof WorkspaceFilesCommands>(
  name: K,
  environmentId: EnvironmentId,
  input: CommandInput<K>,
) {
  const command = workspaceFilesEnvironment[name];
  const result = await runAtomCommand(appAtomRegistry, command as never, { environmentId, input });
  if (result._tag === "Success") return result.value as WorkspaceFilesSignedUrlResult;
  const error = Cause.squash(result.cause) as { message?: string; failure?: string };
  throw failure(error?.message ?? String(error), error?.failure);
}

function absoluteUrl(environmentId: EnvironmentId, relativeUrl: string): string {
  const connection = readPreparedConnection(environmentId);
  const url = connection ? resolveAssetUrl(connection.httpBaseUrl, relativeUrl) : null;
  if (!url) throw failure("This environment is not connected.", "failed");
  return url;
}

const readEntries = (reader: FileSystemDirectoryReader) =>
  new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));

const readFile = (entry: FileSystemFileEntry) =>
  new Promise<File>((resolve, reject) => entry.file(resolve, reject));

/**
 * Files in a drop, folders included. Entries must be taken during the drop event; the walk runs
 * after it. Empty folders are listed so they can be created.
 */
export function takeDroppedEntries(dataTransfer: DataTransfer) {
  const entries: FileSystemEntry[] = [];
  const looseFiles: File[] = [];
  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
    else {
      const file = item.getAsFile();
      if (file) looseFiles.push(file);
    }
  }
  return async () => {
    const files: DroppedFile[] = looseFiles.map((file) => ({ relativePath: file.name, file }));
    const directories: string[] = [];
    const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
      const relativePath = `${prefix}${entry.name}`;
      if (entry.isFile) {
        files.push({ relativePath, file: await readFile(entry as FileSystemFileEntry) });
        return;
      }
      if (!entry.isDirectory) return;
      directories.push(relativePath);
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries returns at most ~100 entries per call.
      for (
        let batch = await readEntries(reader);
        batch.length > 0;
        batch = await readEntries(reader)
      ) {
        for (const child of batch) await walk(child, `${relativePath}/`);
      }
    };
    for (const entry of entries) await walk(entry, "");
    return { files, directories };
  };
}

export function joinWorkspacePath(directory: string, name: string): string {
  return directory ? `${directory}/${name}` : name;
}

function keepBothName(relativePath: string, attempt: number): string {
  const slash = relativePath.lastIndexOf("/");
  const directory = relativePath.slice(0, slash + 1);
  const name = relativePath.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  return `${directory}${stem} (${attempt})${extension}`;
}

function post(url: string, file: File, onProgress: (loaded: number) => void): Promise<void> {
  const xhr = new XMLHttpRequest();
  return new Promise((resolve, reject) => {
    xhr.open("POST", url, true);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.addEventListener("progress", (event) => onProgress(event.loaded));
    xhr.addEventListener("load", () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(failure(xhr.responseText || `HTTP ${xhr.status}`, "failed")),
    );
    xhr.addEventListener("error", () => reject(failure("The upload connection failed.", "failed")));
    xhr.send(file);
  });
}

export interface UploadReport {
  readonly uploaded: number;
  readonly skipped: number;
  readonly failed: ReadonlyArray<{ readonly relativePath: string; readonly message: string }>;
}

/**
 * Uploads `files` below `targetDirectory`. The first name that already exists asks
 * `chooseConflict` once; its answer applies to the rest of the batch.
 */
export async function uploadFiles(options: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly targetDirectory: string;
  readonly files: readonly DroppedFile[];
  readonly directories?: readonly string[];
  readonly chooseConflict: () => Promise<ConflictChoice | null>;
  readonly onProgress: (loadedBytes: number, totalBytes: number) => void;
}): Promise<UploadReport> {
  const { environmentId, cwd, targetDirectory } = options;
  const totalBytes = options.files.reduce((sum, { file }) => sum + file.size, 0);
  const loadedByFile = new Map<string, number>();
  const report = () =>
    options.onProgress(
      [...loadedByFile.values()].reduce((sum, value) => sum + value, 0),
      totalBytes,
    );
  let choice: Promise<ConflictChoice | null> | null = null;
  let uploaded = 0;
  let skipped = 0;
  const failed: { relativePath: string; message: string }[] = [];

  for (const directory of options.directories ?? []) {
    await runWorkspaceFilesCommand("makeDirectory", environmentId, {
      cwd,
      relativePath: joinWorkspacePath(targetDirectory, directory),
    }).catch(() => undefined);
  }

  const uploadOne = async ({ relativePath, file }: DroppedFile) => {
    const destination = joinWorkspacePath(targetDirectory, relativePath);
    const request = (path: string, overwrite: boolean) =>
      runWorkspaceFilesCommand("createUploadUrl", environmentId, {
        cwd,
        relativePath: path,
        sizeBytes: file.size,
        overwrite,
      });
    let signed: WorkspaceFilesSignedUrlResult;
    try {
      signed = await request(destination, false);
    } catch (error) {
      if (!isExistsFailure(error)) throw error;
      choice ??= options.chooseConflict();
      const decided = await choice;
      if (decided === null || decided === "skip") {
        skipped += 1;
        return;
      }
      if (decided === "replace") {
        signed = await request(destination, true);
      } else {
        let attempt = 1;
        for (;;) {
          try {
            signed = await request(keepBothName(destination, attempt), false);
            break;
          } catch (retryError) {
            if (!isExistsFailure(retryError) || attempt >= 50) throw retryError;
            attempt += 1;
          }
        }
      }
    }
    await post(absoluteUrl(environmentId, signed.relativeUrl), file, (loaded) => {
      loadedByFile.set(relativePath, loaded);
      report();
    });
    loadedByFile.set(relativePath, file.size);
    report();
    uploaded += 1;
  };

  const queue = [...options.files];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      try {
        await uploadOne(next);
      } catch (error) {
        failed.push({
          relativePath: next.relativePath,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker));
  return { uploaded, skipped, failed };
}

interface SaveFilePickerWindow {
  showSaveFilePicker?: (options: { suggestedName: string }) => Promise<FileSystemFileHandle>;
}

/** The name the server gives a download: the entry's name, with `.zip` for a folder. */
export function downloadName(cwd: string, relativePath: string, isDirectory: boolean): string {
  const name = (relativePath || cwd).split(/[\\/]/).findLast(Boolean) ?? "download";
  return isDirectory ? `${name}.zip` : name;
}

const errorName = (error: unknown) =>
  typeof error === "object" && error !== null && "name" in error ? String(error.name) : "";

/**
 * Browser client only: asks where to save with the File System Access picker, then streams the
 * signed URL into the chosen file. The picker opens before the URL is signed so the click's user
 * activation is still fresh. Returns "unsupported" when the anchor download should run instead:
 * no picker, the desktop shell (its main process shows the dialog), or activation was lost.
 */
export async function saveThroughFilePicker(options: {
  readonly suggestedName: string;
  readonly resolveUrl: () => Promise<string>;
}): Promise<"saved" | "cancelled" | "unsupported"> {
  const picker = (window as SaveFilePickerWindow).showSaveFilePicker;
  if (isElectron || typeof picker !== "function") return "unsupported";
  let handle: FileSystemFileHandle;
  try {
    handle = await picker.call(window, { suggestedName: options.suggestedName });
  } catch (error) {
    const name = errorName(error);
    if (name === "AbortError") return "cancelled";
    if (name === "SecurityError" || name === "NotAllowedError") return "unsupported";
    throw error;
  }
  const writable = await handle.createWritable();
  try {
    const response = await fetch(await options.resolveUrl());
    if (!response.ok || !response.body) {
      throw failure((await response.text().catch(() => "")) || `HTTP ${response.status}`, "failed");
    }
    // pipeTo closes the file on success and aborts it on a stream error.
    await response.body.pipeTo(writable);
    return "saved";
  } catch (error) {
    await writable.abort().catch(() => undefined);
    throw error;
  }
}

/**
 * Saves a file, or a folder as .zip. The browser client asks where with the file picker; the
 * desktop shell clicks a download link and its main process shows the Save As dialog.
 */
export async function downloadEntry(options: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly isDirectory: boolean;
}): Promise<void> {
  const signUrl = async () => {
    const signed = await runWorkspaceFilesCommand("createDownloadUrl", options.environmentId, {
      cwd: options.cwd,
      relativePath: options.relativePath,
    });
    return {
      url: absoluteUrl(options.environmentId, signed.relativeUrl),
      fileName: signed.fileName,
    };
  };
  const picked = await saveThroughFilePicker({
    suggestedName: downloadName(options.cwd, options.relativePath, options.isDirectory),
    resolveUrl: async () => (await signUrl()).url,
  });
  if (picked !== "unsupported") return;
  const { url, fileName } = await signUrl();
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}
