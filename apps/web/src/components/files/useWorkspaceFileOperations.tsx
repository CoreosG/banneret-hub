// Banneret Hub: VS Code-style file operations for the workspace file tree. Drop files from the OS
// onto a folder to upload, drag rows to move, rename inline, delete, new folder, download.
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { AuthFilesystemReadScope, AuthFilesystemWriteScope } from "@t3tools/contracts";
import type { ContextMenuItem, EnvironmentId } from "@t3tools/contracts";
import type { FileTree, FileTreeDropResult, FileTreeRenameEvent } from "@pierre/trees";
import { useGT } from "gt-react";
import { type DragEvent, useRef, useState } from "react";

import { toastManager } from "~/components/ui/toast";
import { useStableCallback } from "~/hooks/useStableCallback";
import { m } from "~/i18n/messages";
import { readLocalApi } from "~/localApi";
import { useEnvironmentScope } from "~/state/session";

import {
  type ConflictChoice,
  type DroppedFile,
  downloadEntry,
  joinWorkspacePath,
  runWorkspaceFilesCommand,
  takeDroppedEntries,
  uploadFiles,
} from "./workspaceFileTransfers";

export type WorkspaceFileMenuAction =
  | "banneret:new-folder"
  | "banneret:upload"
  | "banneret:rename"
  | "banneret:download"
  | "banneret:delete";

type TreeHandle = Pick<FileTree, "getItem" | "startRenaming">;

const stripSlash = (path: string) => path.replace(/\/+$/, "");
const parentOf = (path: string) => {
  const slash = stripSlash(path).lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
};
const baseName = (path: string) => stripSlash(path).split("/").at(-1) ?? path;

function itemPathFromEvent(event: DragEvent<HTMLElement>): string | null {
  for (const node of event.nativeEvent.composedPath()) {
    const element = node as { getAttribute?: (name: string) => string | null };
    const path = element.getAttribute?.("data-item-path");
    if (path) return path;
  }
  return null;
}

/** The folder a drop lands in: the hovered folder, a hovered file's folder, or the root. */
const dropDirectoryOf = (itemPath: string | null) =>
  itemPath === null ? "" : itemPath.endsWith("/") ? stripSlash(itemPath) : parentOf(itemPath);

export function useWorkspaceFileOperations(options: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly enabled: boolean;
  readonly knownPaths: { has(path: string): boolean };
  readonly reload: (directories: readonly string[]) => Promise<void>;
  readonly tree: () => TreeHandle;
}) {
  const gt = useGT();
  const { environmentId, cwd } = options;
  const canWrite = useEnvironmentScope(environmentId, AuthFilesystemWriteScope) && options.enabled;
  const canRead = useEnvironmentScope(environmentId, AuthFilesystemReadScope) && options.enabled;
  const [dropDirectory, setDropDirectory] = useState<string | null>(null);
  const dropPointRef = useRef({ x: 0, y: 0 });
  const pendingRenameRef = useRef<string | null>(null);

  const reportError = (title: string, error: unknown) =>
    toastManager.add({
      type: "error",
      title,
      description: thrownErrorMessage(error, m) ?? gt("An error occurred."),
    });

  const chooseConflict = async (): Promise<ConflictChoice | null> => {
    const api = readLocalApi();
    if (!api) return "skip";
    const items: ContextMenuItem<ConflictChoice | "title">[] = [
      { id: "title", label: gt("Some items already exist here"), header: true },
      { id: "replace", label: gt("Replace existing files") },
      { id: "keep-both", label: gt("Keep both (rename the new files)") },
      { id: "skip", label: gt("Skip existing files") },
    ];
    const clicked = await api.contextMenu.show(items, dropPointRef.current);
    return clicked === "title" ? null : clicked;
  };

  const runUpload = async (
    targetDirectory: string,
    collect: () => Promise<{ files: DroppedFile[]; directories: string[] }>,
  ) => {
    const { files, directories } = await collect();
    if (files.length === 0 && directories.length === 0) return;
    const where = targetDirectory || gt("the workspace root");
    const toastId = toastManager.add({
      type: "loading",
      title: gt("Uploading {count} files to {where}", { count: String(files.length), where }),
      timeout: 0,
    });
    try {
      const result = await uploadFiles({
        environmentId,
        cwd,
        targetDirectory,
        files,
        directories,
        chooseConflict,
        onProgress: (loaded, total) =>
          toastManager.update(toastId, {
            description: `${Math.round((100 * loaded) / Math.max(total, 1))}%`,
          }),
      });
      toastManager.close(toastId);
      if (result.failed.length > 0) {
        toastManager.add({
          type: "error",
          title: gt("{count} uploads failed", { count: String(result.failed.length) }),
          description: result.failed
            .slice(0, 3)
            .map((failure) => `${failure.relativePath}: ${failure.message}`)
            .join("\n"),
        });
      } else {
        toastManager.add({
          type: "success",
          title: gt("Uploaded {count} files", { count: String(result.uploaded) }),
          ...(result.skipped > 0
            ? { description: gt("Skipped {count} existing", { count: String(result.skipped) }) }
            : {}),
        });
      }
    } catch (error) {
      toastManager.close(toastId);
      reportError(gt("Upload failed"), error);
    } finally {
      await options.reload([targetDirectory]);
    }
  };

  const pickAndUpload = (targetDirectory: string) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.addEventListener("change", () => {
      const files = Array.from(input.files ?? []).map((file) => ({
        relativePath: file.name,
        file,
      }));
      void runUpload(targetDirectory, async () => ({ files, directories: [] }));
    });
    input.click();
  };

  const move = async (fromPath: string, toPath: string) => {
    if (fromPath === toPath) return;
    try {
      await runWorkspaceFilesCommand("move", environmentId, { cwd, fromPath, toPath });
    } catch (error) {
      reportError(gt("Could not move {name}", { name: baseName(fromPath) }), error);
    }
  };

  const newFolder = async (parent: string) => {
    let name = gt("New folder");
    for (let index = 2; options.knownPaths.has(joinWorkspacePath(parent, name)); index++) {
      name = `${gt("New folder")} ${index}`;
    }
    const relativePath = joinWorkspacePath(parent, name);
    try {
      await runWorkspaceFilesCommand("makeDirectory", environmentId, { cwd, relativePath });
      const parentItem = parent ? options.tree().getItem(`${parent}/`) : null;
      if (parentItem && "expand" in parentItem) parentItem.expand();
      pendingRenameRef.current = `${relativePath}/`;
      await options.reload([parent]);
    } catch (error) {
      reportError(gt("Could not create the folder"), error);
    }
  };

  const remove = async (relativePath: string, isDirectory: boolean) => {
    const api = readLocalApi();
    const confirmed = await api?.dialogs.confirm(
      isDirectory
        ? gt("Delete the folder '{name}' and everything in it? This cannot be undone.", {
            name: baseName(relativePath),
          })
        : gt("Delete '{name}'? This cannot be undone.", { name: baseName(relativePath) }),
      { variant: "destructive" },
    );
    if (!confirmed) return;
    try {
      await runWorkspaceFilesCommand("delete", environmentId, { cwd, relativePath });
    } catch (error) {
      reportError(gt("Could not delete {name}", { name: baseName(relativePath) }), error);
    }
    await options.reload([parentOf(relativePath)]);
  };

  return {
    canWrite,
    dropDirectory,
    dropIndicator:
      dropDirectory === null ? null : (
        <div
          role="status"
          className="shrink-0 border-t border-primary/40 bg-primary/10 px-3 py-1.5 text-xs text-foreground"
        >
          {gt("Drop to upload into {folder}", {
            folder: dropDirectory || gt("the workspace root"),
          })}
        </div>
      ),

    /** Starts the inline rename a new folder asked for, once its row exists. */
    flushPendingRename: useStableCallback(() => {
      const path = pendingRenameRef.current;
      if (path === null || !options.tree().getItem(path)) return;
      pendingRenameRef.current = null;
      requestAnimationFrame(() => options.tree().startRenaming(path));
    }),

    dragAndDrop: {
      canDrag: () => canWrite,
      canDrop: () => canWrite,
      onDropComplete: (event: FileTreeDropResult) => {
        const target = event.target.directoryPath ? stripSlash(event.target.directoryPath) : "";
        const sources = event.draggedPaths.map(stripSlash);
        void (async () => {
          for (const source of sources) {
            if (parentOf(source) === target) continue;
            await move(source, joinWorkspacePath(target, baseName(source)));
          }
          await options.reload([target, ...sources.map(parentOf)]);
        })();
      },
      onDropError: (message: string) =>
        toastManager.add({ type: "error", title: gt("Could not move"), description: message }),
    },

    renaming: {
      canRename: () => canWrite,
      onRename: (event: FileTreeRenameEvent) => {
        const from = stripSlash(event.sourcePath);
        const to = stripSlash(event.destinationPath);
        void move(from, to).then(() => options.reload([parentOf(from), parentOf(to)]));
      },
      onError: (message: string) =>
        toastManager.add({ type: "error", title: gt("Could not rename"), description: message }),
    },

    menuItems: (isDirectory: boolean): ContextMenuItem<WorkspaceFileMenuAction>[] => [
      ...(canWrite
        ? [
            {
              id: "banneret:new-folder" as const,
              label: gt("New folder…"),
              separatorBefore: true,
            },
            { id: "banneret:upload" as const, label: gt("Upload files here…") },
            { id: "banneret:rename" as const, label: gt("Rename…") },
          ]
        : []),
      ...(canRead
        ? [
            {
              id: "banneret:download" as const,
              label: isDirectory ? gt("Download as .zip") : gt("Download"),
              separatorBefore: !canWrite,
            },
          ]
        : []),
      ...(canWrite
        ? [{ id: "banneret:delete" as const, label: gt("Delete…"), destructive: true }]
        : []),
    ],

    runMenuAction: (action: string, treePath: string, isDirectory: boolean): boolean => {
      const relativePath = stripSlash(treePath);
      const folder = isDirectory ? relativePath : parentOf(relativePath);
      switch (action) {
        case "banneret:new-folder":
          void newFolder(folder);
          return true;
        case "banneret:upload":
          pickAndUpload(folder);
          return true;
        case "banneret:rename":
          options.tree().startRenaming(treePath);
          return true;
        case "banneret:download":
          void downloadEntry({ environmentId, cwd, relativePath }).catch((error) =>
            reportError(gt("Download failed"), error),
          );
          return true;
        case "banneret:delete":
          void remove(relativePath, isDirectory);
          return true;
        default:
          return false;
      }
    },

    /** Handlers for the panel element: OS files dropped on a row upload into that folder. */
    dropHandlers: {
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (!canWrite || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        const directory = dropDirectoryOf(itemPathFromEvent(event));
        if (directory !== dropDirectory) setDropDirectory(directory);
      },
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        setDropDirectory(null);
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        if (!canWrite || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.stopPropagation();
        setDropDirectory(null);
        dropPointRef.current = { x: event.clientX, y: event.clientY };
        const target = dropDirectoryOf(itemPathFromEvent(event));
        void runUpload(target, takeDroppedEntries(event.dataTransfer));
      },
    },
  };
}
