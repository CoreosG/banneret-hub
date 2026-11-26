import { describe, expect, it, vi } from "vite-plus/test";

import { downloadName, saveThroughFilePicker } from "./workspaceFileTransfers";

type PickerWindow = { showSaveFilePicker?: unknown };

/** Installs a picker for the test; disposing removes it and any stubbed globals. */
function installPicker(picker: unknown): Disposable {
  (window as PickerWindow).showSaveFilePicker = picker;
  return {
    [Symbol.dispose]() {
      Reflect.deleteProperty(window, "showSaveFilePicker");
      vi.unstubAllGlobals();
    },
  };
}

describe("downloadName", () => {
  it("names a file after itself and a folder after itself with .zip", () => {
    expect(downloadName("/repo", "src/index.ts", false)).toBe("index.ts");
    expect(downloadName("/repo", "src", true)).toBe("src.zip");
    expect(downloadName("C:\\work\\repo", "", true)).toBe("repo.zip");
  });
});

describe("saveThroughFilePicker", () => {
  it("streams the signed URL into the picked file", async () => {
    const chunks: string[] = [];
    let closed = false;
    const writable = new WritableStream<Uint8Array>({
      write: (chunk) => void chunks.push(new TextDecoder().decode(chunk)),
      close: () => void (closed = true),
    });
    const picker = vi.fn(async () => ({ createWritable: async () => writable }));
    using _picker = installPicker(picker);
    const fetchMock = vi.fn(async () => new Response("hello"));
    vi.stubGlobal("fetch", fetchMock);
    const resolveUrl = vi.fn(async () => "https://remote.example/api/workspace-files/download/t/a");

    await expect(saveThroughFilePicker({ suggestedName: "src.zip", resolveUrl })).resolves.toBe(
      "saved",
    );
    expect(picker).toHaveBeenCalledWith({ suggestedName: "src.zip" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://remote.example/api/workspace-files/download/t/a",
    );
    expect(chunks.join("")).toBe("hello");
    expect(closed).toBe(true);
  });

  it("does nothing when the picker is cancelled", async () => {
    using _picker = installPicker(
      vi.fn(async () => Promise.reject(new DOMException("cancelled", "AbortError"))),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const resolveUrl = vi.fn(async () => "unused");

    await expect(saveThroughFilePicker({ suggestedName: "a.txt", resolveUrl })).resolves.toBe(
      "cancelled",
    );
    expect(resolveUrl).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to the link download without a picker or user activation", async () => {
    const resolveUrl = vi.fn(async () => "unused");
    await expect(saveThroughFilePicker({ suggestedName: "a.txt", resolveUrl })).resolves.toBe(
      "unsupported",
    );
    using _picker = installPicker(
      vi.fn(async () => Promise.reject(new DOMException("no", "SecurityError"))),
    );
    await expect(saveThroughFilePicker({ suggestedName: "a.txt", resolveUrl })).resolves.toBe(
      "unsupported",
    );
    expect(resolveUrl).not.toHaveBeenCalled();
  });

  it("discards the partial file when the download fails", async () => {
    let aborted = false;
    const writable = new WritableStream<Uint8Array>({ abort: () => void (aborted = true) });
    using _picker = installPicker(vi.fn(async () => ({ createWritable: async () => writable })));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("gone", { status: 404 })),
    );

    await expect(
      saveThroughFilePicker({ suggestedName: "a.txt", resolveUrl: async () => "x" }),
    ).rejects.toThrow("gone");
    expect(aborted).toBe(true);
  });
});
