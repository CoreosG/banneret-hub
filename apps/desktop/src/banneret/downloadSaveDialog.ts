// @effect-diagnostics nodeBuiltinImport:off - a synchronous Electron will-download callback builds the native dialog path.
// Banneret Hub: file-explorer downloads ask where to save, like VS Code. The web client clicks an
// <a download> on the server's signed workspace-download URL (local or remote environment); here
// the main window's session catches it and shows the native Save As dialog. Other downloads keep
// Electron's default handling; preview and browser sessions have their own handlers.
import * as NodePath from "node:path";

import { WORKSPACE_FILES_DOWNLOAD_ROUTE_PREFIX } from "@t3tools/contracts";
import * as Electron from "electron";

const sessionsWithHandler = new WeakSet<Electron.Session>();

/**
 * The signed route is `<base>/api/workspace-files/download/<token>/<file name>` on any origin and
 * scheme (a remote server, the local server, or the desktop protocol).
 */
export function isWorkspaceDownloadUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  const marker = `${WORKSPACE_FILES_DOWNLOAD_ROUTE_PREFIX}/`;
  const index = url.pathname.lastIndexOf(marker);
  if (index < 0) return false;
  const [token, fileName, ...rest] = url.pathname.slice(index + marker.length).split("/");
  return Boolean(token) && Boolean(fileName) && rest.length === 0;
}

/**
 * Chromium's suggested name comes from Content-Disposition (a folder arrives as `<name>.zip`);
 * the last URL segment is the server's own file name if Chromium has none.
 */
export function downloadFileName(suggestedFileName: string, rawUrl: string): string {
  if (suggestedFileName.trim()) return suggestedFileName;
  try {
    const segment = new URL(rawUrl).pathname.split("/").pop() ?? "";
    const decoded = decodeURIComponent(segment);
    if (decoded.trim()) return NodePath.basename(decoded);
  } catch {
    // Fall through to the generic name.
  }
  return "download";
}

export function saveDialogDefaultPath(downloadsDirectory: string, fileName: string): string {
  return NodePath.join(downloadsDirectory, fileName);
}

function onWillDownload(
  _event: Electron.Event,
  item: Electron.DownloadItem,
  webContents: Electron.WebContents,
) {
  if (!isWorkspaceDownloadUrl(item.getURL())) return;
  const options: Electron.SaveDialogOptions = {
    defaultPath: saveDialogDefaultPath(
      Electron.app.getPath("downloads"),
      downloadFileName(item.getFilename(), item.getURL()),
    ),
  };
  // The save path must be set before this handler returns, so the dialog is synchronous.
  // Chromium writes to a temporary file until the path is known; cancel removes it.
  const owner = Electron.BrowserWindow.fromWebContents(webContents);
  const savePath = owner
    ? Electron.dialog.showSaveDialogSync(owner, options)
    : Electron.dialog.showSaveDialogSync(options);
  if (savePath) item.setSavePath(savePath);
  else item.cancel();
}

/** Installs the handler once per session; later main windows share the default session. */
export function installWorkspaceDownloadSaveDialog(session: Electron.Session): void {
  // Test doubles and non-Electron sessions have no event emitter; nothing to hook there.
  if (typeof session.on !== "function" || sessionsWithHandler.has(session)) return;
  sessionsWithHandler.add(session);
  session.on("will-download", onWillDownload);
}
