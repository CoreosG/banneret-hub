// @effect-diagnostics nodeBuiltinImport:off -- the test reads the zip bytes it downloads.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import type { WorkspaceFilesError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as AssetSigner from "../assets/AssetSigner.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as KnownWorkspaces from "./KnownWorkspaces.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./WorkspaceFileSystem.ts";
import * as WorkspaceFiles from "./WorkspaceFiles.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const layerServices = Layer.empty.pipe(
  Layer.provideMerge(
    WorkspaceFileSystem.layer.pipe(
      Layer.provide(
        Layer.mock(KnownWorkspaces.KnownWorkspaces)({ assertContains: () => Effect.void }),
      ),
      Layer.provide(WorkspacePaths.layer),
      Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
    ),
  ),
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provideMerge(AssetSigner.layer.pipe(Layer.provideMerge(ServerSecretStore.layer))),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "banneret-files-test-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

// The RPC handlers run behind a test route, so URLs are signed and verified with the same key.
const layerRpcRoute = HttpRouter.add(
  "POST",
  "/test-rpc/*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const method = decodeURIComponent(request.url.split("/test-rpc/")[1] ?? "");
    const input = yield* request.json;
    const handler: (
      input: never,
    ) => Effect.Effect<
      unknown,
      WorkspaceFilesError,
      | AssetSigner.AssetSigner
      | WorkspaceEntries.WorkspaceEntries
      | WorkspaceFileSystem.WorkspaceFileSystem
    > = WorkspaceFiles.rpcHandlers[method as keyof typeof WorkspaceFiles.rpcHandlers];
    return yield* handler(input as never).pipe(
      Effect.map((result) => HttpServerResponse.jsonUnsafe({ ok: true, result })),
      Effect.catch((error) =>
        Effect.succeed(HttpServerResponse.jsonUnsafe({ ok: false, failure: error.failure })),
      ),
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
    ),
  ),
);

const app = HttpRouter.toWebHandler(
  Layer.mergeAll(
    layerRpcRoute,
    WorkspaceFiles.layerUploadRoute,
    WorkspaceFiles.layerDownloadRoute,
  ).pipe(Layer.provideMerge(layerServices)),
  { disableLogger: true },
);

const base = "http://server.test";
let cwd = "";

async function rpc(method: string, input: Record<string, unknown>) {
  const response = await app.handler(
    new Request(`${base}/test-rpc/${method}`, {
      method: "POST",
      body: JSON.stringify({ cwd, ...input }),
      headers: { "content-type": "application/json" },
    }),
  );
  const text = await response.text();
  if (response.status === 500) throw new Error(text);
  return JSON.parse(text) as {
    ok: boolean;
    failure?: string;
    result?: { relativeUrl: string; fileName: string };
  };
}

const write = (relativePath: string, contents: string) => {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(cwd, relativePath)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(cwd, relativePath), contents);
};
const read = (relativePath: string) =>
  NodeFS.readFileSync(NodePath.join(cwd, relativePath), "utf8");
const exists = (relativePath: string) => NodeFS.existsSync(NodePath.join(cwd, relativePath));

/** Entries of a zip, inflated, checked against their CRC. */
function unzip(bytes: Buffer): Map<string, string | null> {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = bytes.readUInt16LE(end + 10);
  let cursor = bytes.readUInt32LE(end + 16);
  const entries = new Map<string, string | null>();
  for (let index = 0; index < count; index++) {
    expect(bytes.readUInt32LE(cursor)).toBe(0x02014b50);
    const method = bytes.readUInt16LE(cursor + 10);
    const crc = bytes.readUInt32LE(cursor + 16);
    const compressed = bytes.readUInt32LE(cursor + 20);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const offset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    cursor += 46 + nameLength;
    if (name.endsWith("/")) {
      entries.set(name, null);
      continue;
    }
    const start = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
    const data = bytes.subarray(start, start + compressed);
    const contents = method === 8 ? NodeZlib.inflateRawSync(data) : data;
    expect(NodeZlib.crc32(contents) >>> 0).toBe(crc);
    entries.set(name, contents.toString("utf8"));
  }
  return entries;
}

beforeAll(() => {
  cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "banneret-files-"));
});
afterAll(async () => {
  await app.dispose();
  NodeFS.rmSync(cwd, { recursive: true, force: true });
});

describe("WorkspaceFiles", () => {
  it("creates, renames, moves and deletes entries", async () => {
    write("notes.txt", "hello");
    expect((await rpc("workspaceFiles.makeDirectory", { relativePath: "docs" })).ok).toBe(true);
    expect((await rpc("workspaceFiles.makeDirectory", { relativePath: "docs" })).failure).toBe(
      "exists",
    );

    expect(
      (await rpc("workspaceFiles.move", { fromPath: "notes.txt", toPath: "readme.txt" })).ok,
    ).toBe(true);
    expect(read("readme.txt")).toBe("hello");
    expect(
      (await rpc("workspaceFiles.move", { fromPath: "readme.txt", toPath: "docs/readme.txt" })).ok,
    ).toBe(true);
    expect(read("docs/readme.txt")).toBe("hello");

    write("other.txt", "x");
    expect(
      (await rpc("workspaceFiles.move", { fromPath: "other.txt", toPath: "docs/readme.txt" }))
        .failure,
    ).toBe("exists");
    expect(
      (await rpc("workspaceFiles.move", { fromPath: "docs", toPath: "docs/inner/docs" })).failure,
    ).toBe("invalid");

    expect((await rpc("workspaceFiles.delete", { relativePath: "docs" })).ok).toBe(true);
    expect(exists("docs")).toBe(false);
    expect((await rpc("workspaceFiles.delete", { relativePath: "docs" })).failure).toBe(
      "not_found",
    );
  });

  it("refuses paths outside the workspace and inside .git", async () => {
    write(".git/config", "[core]");
    expect((await rpc("workspaceFiles.delete", { relativePath: "../outside.txt" })).failure).toBe(
      "invalid",
    );
    expect((await rpc("workspaceFiles.delete", { relativePath: ".git/config" })).failure).toBe(
      "outside_workspace",
    );
    expect(
      (await rpc("workspaceFiles.move", { fromPath: "other.txt", toPath: ".git/hooks/x" })).failure,
    ).toBe("outside_workspace");
    expect(read(".git/config")).toBe("[core]");
  });

  it("uploads through a signed URL, refusing to replace unless asked", async () => {
    const upload = async (relativePath: string, body: string, overwrite: boolean) => {
      const signed = await rpc("workspaceFiles.createUploadUrl", {
        relativePath,
        sizeBytes: Buffer.byteLength(body),
        overwrite,
      });
      if (!signed.ok) return signed.failure;
      const response = await app.handler(
        new Request(`${base}${signed.result!.relativeUrl}`, { method: "POST", body }),
      );
      return response.status;
    };
    expect(await upload("incoming/deep/file.bin", "first", false)).toBe(204);
    expect(read("incoming/deep/file.bin")).toBe("first");
    expect(await upload("incoming/deep/file.bin", "second", false)).toBe("exists");
    expect(await upload("incoming/deep/file.bin", "second", true)).toBe(204);
    expect(read("incoming/deep/file.bin")).toBe("second");
    expect(NodeFS.readdirSync(NodePath.join(cwd, "incoming/deep"))).toEqual(["file.bin"]);

    const forged = await app.handler(
      new Request(`${base}/api/workspace-files/upload/e30.bad`, { method: "POST", body: "x" }),
    );
    expect(forged.status).toBe(404);
  });

  it("downloads a file as is and a folder as a zip", async () => {
    write("pkg/src/index.ts", "export const value = 1;\n".repeat(50));
    write("pkg/README.md", "# pkg");
    write("pkg/.git/HEAD", "ref: refs/heads/main");
    NodeFS.mkdirSync(NodePath.join(cwd, "pkg/empty"));

    const file = await rpc("workspaceFiles.createDownloadUrl", { relativePath: "pkg/README.md" });
    const fileResponse = await app.handler(new Request(`${base}${file.result!.relativeUrl}`));
    expect(fileResponse.headers.get("content-disposition")).toContain('filename="README.md"');
    expect(await fileResponse.text()).toBe("# pkg");

    const folder = await rpc("workspaceFiles.createDownloadUrl", { relativePath: "pkg" });
    expect(folder.result!.fileName).toBe("pkg.zip");
    const zipResponse = await app.handler(new Request(`${base}${folder.result!.relativeUrl}`));
    expect(zipResponse.headers.get("content-type")).toBe("application/zip");
    const entries = unzip(Buffer.from(await zipResponse.arrayBuffer()));
    expect([...entries.keys()].toSorted()).toEqual([
      "pkg/",
      "pkg/README.md",
      "pkg/empty/",
      "pkg/src/",
      "pkg/src/index.ts",
    ]);
    expect(entries.get("pkg/src/index.ts")).toBe("export const value = 1;\n".repeat(50));
  });
});
