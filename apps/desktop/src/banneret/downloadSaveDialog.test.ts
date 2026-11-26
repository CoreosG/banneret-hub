// @effect-diagnostics nodeBuiltinImport:off - expected paths use the platform separator, like the module under test.
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  downloadFileName,
  downloadInsteadOfNavigating,
  installWorkspaceDownloadSaveDialog,
  isWorkspaceDownloadUrl,
  makeWillDownloadHandler,
  saveDialogDefaultPath,
  type SaveDialogHost,
} from "./downloadSaveDialog.ts";

const downloads = NodePath.join("home", "me", "Downloads");

function fakeItem(url: string, filename: string) {
  const calls: Array<string> = [];
  return {
    calls,
    item: {
      getURL: () => url,
      getFilename: () => filename,
      setSavePath: (path: string) => void calls.push(`save ${path}`),
      cancel: () => void calls.push("cancel"),
    },
  };
}

function fakeHost(answer: string | undefined) {
  const prompts: Array<string | undefined> = [];
  const host: SaveDialogHost = {
    downloadsDirectory: () => downloads,
    showSaveDialog: (_webContents, options) => {
      prompts.push(options.defaultPath);
      return answer;
    },
  };
  return { host, prompts };
}

function fakeSession() {
  const listeners: Array<{ event: string; listener: unknown }> = [];
  return {
    listeners,
    session: { on: (event: string, listener: unknown) => void listeners.push({ event, listener }) },
  };
}

const webContents = {} as never;

describe("the main session's will-download handler", () => {
  it("asks where to save any URL: workspace route, blob, remote https", () => {
    const saved = NodePath.join("home", "me", "Desktop", "picked.txt");
    for (const [url, name, expected] of [
      ["http://127.0.0.1:3793/api/workspace-files/download/abc.sig/a.txt", "a.txt", "a.txt"],
      ["blob:banneret://app/6f1c2d3e-0000-4000-8000-000000000000", "notes.md", "notes.md"],
      ["blob:banneret://app/6f1c2d3e-0000-4000-8000-000000000000", "", "download"],
      ["https://cdn.example.com/files/report.pdf", "", "report.pdf"],
    ] as const) {
      const { host, prompts } = fakeHost(saved);
      const { item, calls } = fakeItem(url, name);
      makeWillDownloadHandler(host)({}, item, webContents);
      expect(prompts).toEqual([NodePath.join(downloads, expected)]);
      expect(calls).toEqual([`save ${saved}`]);
    }
  });

  it("keeps a folder's .zip name", () => {
    const { host, prompts } = fakeHost(undefined);
    const { item } = fakeItem(
      "https://box.tail1234.ts.net/api/workspace-files/download/abc.sig/src.zip",
      "src.zip",
    );
    makeWillDownloadHandler(host)({}, item, webContents);
    expect(prompts).toEqual([NodePath.join(downloads, "src.zip")]);
  });

  it("cancels the download when the dialog is cancelled", () => {
    const { host } = fakeHost(undefined);
    const { item, calls } = fakeItem("blob:banneret://app/id", "a.txt");
    makeWillDownloadHandler(host)({}, item, webContents);
    expect(calls).toEqual(["cancel"]);
  });
});

describe("installWorkspaceDownloadSaveDialog", () => {
  it("hooks only the session it is given, once", () => {
    const main = fakeSession();
    const preview = fakeSession();
    installWorkspaceDownloadSaveDialog(main.session, fakeHost(undefined).host);
    installWorkspaceDownloadSaveDialog(main.session, fakeHost(undefined).host);
    expect(main.listeners.map(({ event }) => event)).toEqual(["will-download"]);
    expect(preview.listeners).toEqual([]);
  });
});

describe("downloadInsteadOfNavigating", () => {
  it("downloads a signed workspace URL in the main session instead of the OS browser", () => {
    const started: Array<string> = [];
    const contents = { downloadURL: (url: string) => void started.push(url) };
    const signed =
      "https://box.tail1234.ts.net/api/workspace-files/download/abc.sig/My%20Folder.zip";
    expect(downloadInsteadOfNavigating(contents, signed)).toBe(true);
    expect(downloadInsteadOfNavigating(contents, "https://github.com/CoreosG/banneret-hub")).toBe(
      false,
    );
    expect(started).toEqual([signed]);
  });
});

describe("isWorkspaceDownloadUrl", () => {
  it("matches the signed download route on any origin", () => {
    expect(
      isWorkspaceDownloadUrl("http://127.0.0.1:3773/api/workspace-files/download/abc.sig/a.txt"),
    ).toBe(true);
    expect(
      isWorkspaceDownloadUrl(
        "https://box.tail1234.ts.net/relay/env-1/api/workspace-files/download/abc.sig/My%20Folder.zip",
      ),
    ).toBe(true);
    expect(
      isWorkspaceDownloadUrl("t3code://app/api/workspace-files/download/abc.sig/notes.md"),
    ).toBe(true);
  });

  it("ignores preview, upload and other URLs", () => {
    expect(isWorkspaceDownloadUrl("http://localhost:5173/report.pdf")).toBe(false);
    expect(isWorkspaceDownloadUrl("http://localhost:5173/api/workspace-files/download")).toBe(
      false,
    );
    expect(isWorkspaceDownloadUrl("http://127.0.0.1:3773/api/workspace-files/upload/abc.sig")).toBe(
      false,
    );
    expect(
      isWorkspaceDownloadUrl("http://127.0.0.1:3773/api/workspace-files/download/abc.sig"),
    ).toBe(false);
    expect(
      isWorkspaceDownloadUrl("http://127.0.0.1:3773/api/workspace-files/download/abc.sig/a/b"),
    ).toBe(false);
    expect(isWorkspaceDownloadUrl("not a url")).toBe(false);
  });
});

describe("downloadFileName", () => {
  const url = "https://remote.example/api/workspace-files/download/abc.sig/src.zip";

  it("prefers Chromium's suggested name from Content-Disposition", () => {
    expect(downloadFileName("report final.pdf", url)).toBe("report final.pdf");
  });

  it("keeps a folder's .zip name", () => {
    expect(downloadFileName("src.zip", url)).toBe("src.zip");
    expect(downloadFileName("", url)).toBe("src.zip");
  });

  it("never names a file after a blob URL's id", () => {
    expect(downloadFileName("", "blob:banneret://app/6f1c2d3e-0000-4000-8000-000000000000")).toBe(
      "download",
    );
  });

  it("decodes the URL's file name when Chromium has none", () => {
    expect(
      downloadFileName(
        "",
        "https://remote.example/api/workspace-files/download/abc.sig/My%20Notes.md",
      ),
    ).toBe("My Notes.md");
  });

  it("falls back to a generic name", () => {
    expect(downloadFileName("", "not a url")).toBe("download");
  });
});

describe("saveDialogDefaultPath", () => {
  it("defaults to the file name in the Downloads folder", () => {
    expect(saveDialogDefaultPath(downloads, "src.zip")).toBe(NodePath.join(downloads, "src.zip"));
  });
});
