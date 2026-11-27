import { ToolLevel, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { workspacesFilePath } from "../Workspaces.ts";

export const toolkitSource = "banneret";
export const pluginSource = (source: string) => "plugin:" + source;
const grants = Schema.fromJsonString(Schema.Record(Schema.String, ToolLevel));
const decodeGrants = Schema.decodeEffect(grants);
const encodeGrants = Schema.encodeEffect(grants);
const lock = Semaphore.makeUnsafe(1);
const location = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.join(path.dirname(yield* workspacesFilePath), "tool-levels.json");
});
const read = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* location;
  return (yield* fs.exists(file)) ? yield* decodeGrants(yield* fs.readFileString(file)) : {};
});
const key = (thread: ThreadId, source: string) => JSON.stringify([thread, source]);
export const levelFor = (thread: ThreadId, source: string) =>
  Effect.map(read, (all) => all[key(thread, source)] ?? "read_write");
export const setLevel = (thread: ThreadId, source: string, level: ToolLevel) =>
  lock.withPermits(1)(
    Effect.gen(function* () {
      const all = yield* read;
      const fs = yield* FileSystem.FileSystem;
      const file = yield* location;
      yield* fs.makeDirectory((yield* Path.Path).dirname(file), { recursive: true });
      yield* fs.writeFileString(
        file + ".new",
        yield* encodeGrants({ ...all, [key(thread, source)]: level }),
      );
      yield* fs.rename(file + ".new", file);
    }),
  );

export interface ListedTool {
  name: string;
  annotations?:
    | { readOnlyHint?: boolean | undefined; destructiveHint?: boolean | undefined }
    | undefined;
}
export function classify(tool: ListedTool, prefix = ""): "read" | "write" | "sensitive" {
  if (tool.annotations?.destructiveHint === true) return "sensitive";
  if (tool.annotations?.readOnlyHint === true) return "read";
  const name = tool.name.startsWith(prefix) ? tool.name.slice(prefix.length) : tool.name;
  const words = name
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  if (words.some((w) => ["delete", "remove", "destroy", "revoke", "purge", "pay"].includes(w)))
    return "sensitive";
  if (tool.annotations?.readOnlyHint === false) return "write";
  // Leading read verbs are conventional. For noun-first tools, recognize only known namespaces.
  const readVerb = /^(get|list|search|read|fetch|inspect|query)$/;
  const noun =
    /^(boards?|tasks?|issues?|skills?|notes?|memory|chat|users?|files?|logs?|items?|projects?|records?)$/;
  if (words.length === 1 && readVerb.test(words[0]!)) return "read";
  if (words.length === 2) {
    const [first, second] = words;
    if (
      (readVerb.test(first!) && noun.test(second!)) ||
      (noun.test(first!) && readVerb.test(second!))
    )
      return "read";
  }
  return "write";
}
export const allows = (level: ToolLevel, tool: ListedTool, prefix = "") =>
  level === "read_write" || (level === "read" && classify(tool, prefix) === "read");
export const parkedMessage =
  "This thread's tools are parked between turns. Start a turn to call a tool.";
export const denied = (tool: string, source: string, level: ToolLevel) =>
  tool + " is unavailable. " + source + " is set to " + level + " for this thread.";
