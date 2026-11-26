import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { BanneretWorkspace } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as Workspaces from "./Workspaces.ts";

const layer = ServerConfig.layerTest(process.cwd(), { prefix: "banneret-workspaces-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const workspace = (overrides: Partial<BanneretWorkspace> = {}): BanneretWorkspace => ({
  id: "w1",
  name: "Client work",
  kind: "solo",
  projectKeys: ["repo:github.com/acme/site"],
  updatedAt: "2026-11-26T10:00:00.000Z",
  ...overrides,
});

describe("BanneretWorkspaces", () => {
  it.effect("starts empty, stores puts in the state dir, and keeps the newest copy", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* Workspaces.workspacesFilePath;
      expect(yield* Workspaces.list()).toEqual({ workspaces: [] });

      const newer = workspace({ name: "Renamed", updatedAt: "2026-11-26T11:00:00.000Z" });
      yield* Workspaces.put({ workspaces: [newer] });
      // A stale client's older copy does not overwrite the newer one.
      const afterStale = yield* Workspaces.put({ workspaces: [workspace()] });
      expect(afterStale.workspaces).toEqual([newer]);

      const deleted = workspace({ deleted: true, updatedAt: "2026-11-26T12:00:00.000Z" });
      yield* Workspaces.put({ workspaces: [deleted, workspace({ id: "w2" })] });
      expect(yield* fs.exists(file)).toBe(true);
      expect((yield* Workspaces.list()).workspaces).toEqual([deleted, workspace({ id: "w2" })]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("serializes concurrent puts so neither change is lost", () =>
    Effect.gen(function* () {
      yield* Effect.all(
        [
          Workspaces.put({ workspaces: [workspace({ id: "a" })] }),
          Workspaces.put({ workspaces: [workspace({ id: "b" })] }),
        ],
        { concurrency: "unbounded" },
      );
      expect((yield* Workspaces.list()).workspaces.map((entry) => entry.id)).toEqual(["a", "b"]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads a corrupt file as empty", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = yield* Workspaces.workspacesFilePath;
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* fs.writeFileString(file, "{not json");
      expect(yield* Workspaces.list()).toEqual({ workspaces: [] });
    }).pipe(Effect.provide(layer)),
  );
});
