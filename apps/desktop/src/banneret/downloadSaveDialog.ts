// @effect-diagnostics nodeBuiltinImport:off - a synchronous Electron will-download callback builds the native dialog path.
// Banneret Hub: every download in the main window's session asks where to save, like VS Code:
// workspace files and folders, a file viewer's blob: save, a remote https file. Preview and browser
// sessions keep their own handlers (preview/Manager.ts).
//
// The file explorer's signed download URL is on the server's origin, never the renderer's
// (banneret://app), so Chromium ignores its <a download> attribute and navigates instead. The main
// window's will-navigate handler would hand that navigation to the OS browser, which saves to
// Downloads without asking. `downloadInsteadOfNavigating` turns it into a download in this session.
import * as NodePath from "node:path";

import { WORKSPACE_FILES_DOWNLOAD_ROUTE_PREFIX } from "@t3tools/contracts";
import * as Electron from "electron";

const sessionsWithHandler = new WeakSet<object>();

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
 * Chromium's suggested name comes from Content-Disposition or the anchor's `download` attribute
 * (a folder arrives as `<name>.zip`). Without one, an http(s) URL's last segment names the file;
 * a blob: or data: URL has no file name in it.
 */
export function downloadFileName(suggestedFileName: string, rawUrl: string): string {
  if (suggestedFileName.trim()) return suggestedFileName;
  try {
    const url = new URL(rawUrl);
    if (url.protocol === "http:" || url.protocol === "https:") {
      const decoded = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      if (decoded.trim()) return NodePath.basename(decoded);
    }
  } catch {
    // Fall through to the generic name.
  }
  return "download";
}

export function saveDialogDefaultPath(downloadsDirectory: string, fileName: string): string {
  return NodePath.join(downloadsDirectory, fileName);
}

export interface SaveDialogHost {
  readonly downloadsDirectory: () => string;
  readonly showSaveDialog: (
    webContents: Electron.WebContents,
    options: Electron.SaveDialogOptions,
  ) => string | undefined;
}

const electronHost: SaveDialogHost = {
  downloadsDirectory: () => Electron.app.getPath("downloads"),
  showSaveDialog: (webContents, options) => {
    const owner = Electron.BrowserWindow.fromWebContents(webContents);
    return owner
      ? Electron.dialog.showSaveDialogSync(owner, options)
      : Electron.dialog.showSaveDialogSync(options);
  },
};

type DownloadItem = Pick<
  Electron.DownloadItem,
  "getURL" | "getFilename" | "setSavePath" | "cancel"
>;

/** Asks where to save every download, whatever its URL; cancel removes Chromium's partial file. */
export function makeWillDownloadHandler(host: SaveDialogHost = electronHost) {
  return (_event: unknown, item: DownloadItem, webContents: Electron.WebContents) => {
    const options: Electron.SaveDialogOptions = {
      defaultPath: saveDialogDefaultPath(
        host.downloadsDirectory(),
        downloadFileName(item.getFilename(), item.getURL()),
      ),
    };
    // The save path must be set before this handler returns, so the dialog is synchronous.
    // Chromium writes to a temporary file until the path is known; cancel removes it.
    const savePath = host.showSaveDialog(webContents, options);
    if (savePath) item.setSavePath(savePath);
    else item.cancel();
  };
}

type DownloadSession = Pick<Electron.Session, "on">;

/** Installs the handler once per session; later main windows share the default session. */
export function installWorkspaceDownloadSaveDialog(
  session: DownloadSession,
  host: SaveDialogHost = electronHost,
): void {
  // Test doubles and non-Electron sessions have no event emitter; nothing to hook there.
  if (typeof session.on !== "function" || sessionsWithHandler.has(session)) return;
  sessionsWithHandler.add(session);
  session.on("will-download", makeWillDownloadHandler(host) as never);
}

/**
 * Called from the main window's will-navigate handler after it cancels a cross-origin navigation.
 * A signed workspace download becomes a download in the main session (and so gets the dialog)
 * instead of opening in the OS browser. Returns whether it took the URL.
 */
export function downloadInsteadOfNavigating(
  webContents: Pick<Electron.WebContents, "downloadURL">,
  url: string,
): boolean {
  if (!isWorkspaceDownloadUrl(url)) return false;
  webContents.downloadURL(url);
  return true;
}
