// @effect-diagnostics nodeBuiltinImport:off - expected paths use the platform separator, like the module under test.
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  downloadFileName,
  isWorkspaceDownloadUrl,
  saveDialogDefaultPath,
} from "./downloadSaveDialog.ts";

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
    const downloads = NodePath.join("home", "me", "Downloads");
    expect(saveDialogDefaultPath(downloads, "src.zip")).toBe(NodePath.join(downloads, "src.zip"));
  });
});
