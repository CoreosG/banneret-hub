import { OrchestratorDesignations } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { workspacesFilePath } from "./Workspaces.ts";

const fileSchema = Schema.fromJsonString(Schema.Record(Schema.String, OrchestratorDesignations));
const decode = Schema.decodeEffect(fileSchema);
const encode = Schema.encodeEffect(fileSchema);
export const emptyDesignations: OrchestratorDesignations = { main: null, projects: {} };
const location = Effect.gen(function* () {
  const path = yield* Path.Path;
  const dir = path.dirname(yield* workspacesFilePath);
  return { dir, file: path.join(dir, "orchestrators.json") };
});
export const readDesignations = Effect.gen(function* () {
  const { file } = yield* location;
  const fs = yield* FileSystem.FileSystem;
  return (yield* fs.exists(file))
    ? yield* fs.readFileString(file).pipe(Effect.flatMap(decode))
    : {};
});
export const saveDesignations = Effect.fn(function* (
  workspaceId: string,
  next: OrchestratorDesignations,
) {
  const all = yield* readDesignations;
  const { file, dir } = yield* location;
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(dir, { recursive: true });
  yield* fs.writeFileString(file + ".new", yield* encode({ ...all, [workspaceId]: next }));
  yield* fs.rename(file + ".new", file);
});
