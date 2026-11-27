// Banneret Hub: this environment's copy of the person's workspaces, in a JSON file of our own
// (no database table, so no migration can collide with upstream's numbering).
import {
  BANNERET_WORKSPACES_WS_METHODS,
  BanneretWorkspaceList,
  mergeBanneretWorkspaces,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";

const WorkspacesFileJson = Schema.fromJsonString(BanneretWorkspaceList);
const decodeFile = Schema.decodeUnknownEffect(WorkspacesFileJson);
const encodeFile = Schema.encodeEffect(WorkspacesFileJson);

/** Under the state dir, so a dev server and the installed app keep separate workspaces. */
export const workspacesFilePath = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return path.join(config.stateDir, "banneret", "workspaces.json");
});

// Serializes read-modify-write: two puts from different clients must not drop each other's change.
const fileLock = Semaphore.makeUnsafe(1);

export const readForMemory = Effect.gen(function* () {
  const file = yield* workspacesFilePath;
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(file))) return [];
  return (yield* fs.readFileString(file).pipe(Effect.flatMap(decodeFile))).workspaces;
});

const readFile = Effect.fn("BanneretWorkspaces.readFile")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(file).pipe(
    Effect.flatMap(decodeFile),
    Effect.map((contents) => contents.workspaces),
    // Missing or unreadable: start empty rather than fail the sidebar.
    Effect.orElseSucceed(() => []),
  );
});

const writeFile = Effect.fn("BanneretWorkspaces.writeFile")(function* (
  file: string,
  workspaces: BanneretWorkspaceList["workspaces"],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const contents = yield* encodeFile({ workspaces });
  const staging = `${file}.staging-${process.pid}`;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFileString(staging, contents);
  yield* fs.rename(staging, file);
}, Effect.orDie);

export const list = Effect.fn("BanneretWorkspaces.list")(function* () {
  return { workspaces: yield* readFile(yield* workspacesFilePath) };
});

export const put = Effect.fn("BanneretWorkspaces.put")(function* (input: BanneretWorkspaceList) {
  const file = yield* workspacesFilePath;
  return yield* fileLock.withPermits(1)(
    Effect.gen(function* () {
      const merged = mergeBanneretWorkspaces(yield* readFile(file), input.workspaces);
      yield* writeFile(file, merged);
      return { workspaces: merged };
    }),
  );
});

export const rpcHandlers = {
  [BANNERET_WORKSPACES_WS_METHODS.list]: () => list(),
  [BANNERET_WORKSPACES_WS_METHODS.put]: (input: BanneretWorkspaceList) => put(input),
};
