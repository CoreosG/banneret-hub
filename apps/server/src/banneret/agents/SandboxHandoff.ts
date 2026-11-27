import { CommandId, MessageId, ThreadId, SandboxReceipt } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { workspacesFilePath } from "../Workspaces.ts";
import { BanneretEnrolment, relayHash } from "../relay/Enrolment.ts";
import { BanneretAgentRelays } from "./AgentRelays.ts";

const Watch = Schema.Struct({
  relayOrigin: Schema.String,
  login: Schema.String,
  threadId: ThreadId,
  taskId: Schema.String,
  id: Schema.String,
  delivered: Schema.String,
});
const fileSchema = Schema.fromJsonString(Watch);
const encodeReceipt = Schema.encodeEffect(Schema.fromJsonString(SandboxReceipt));
const encodeWatch = Schema.encodeEffect(fileSchema);
const decodeWatch = Schema.decodeEffect(fileSchema);
const dir = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.join(path.dirname(yield* workspacesFilePath), "sandbox-handoffs");
});
const write = Effect.fn("SandboxHandoff.write")(function* (watch: typeof Watch.Type) {
  const fs = yield* FileSystem.FileSystem;
  const folder = yield* dir;
  yield* fs.makeDirectory(folder, { recursive: true });
  const file = (yield* Path.Path).join(
    folder,
    relayHash(watch.relayOrigin + "/" + watch.id) + ".json",
  );
  yield* fs.writeFileString(file + ".new", yield* encodeWatch(watch), {
    mode: 0o600,
  });
  yield* fs.rename(file + ".new", file);
});

export const follow = (watch: Omit<typeof Watch.Type, "delivered">) =>
  write({ ...watch, delivered: "waiting" });

export const hasHandoff = Effect.fn("SandboxHandoff.hasHandoff")(function* (
  relayOrigin: string,
  login: string,
  taskId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const folder = yield* dir;
  if (!(yield* fs.exists(folder))) return false;
  for (const name of yield* fs.readDirectory(folder)) {
    if (!name.endsWith(".json")) continue;
    const watch = yield* fs.readFileString(path.join(folder, name)).pipe(
      Effect.flatMap(decodeWatch),
      Effect.catchIf(
        (error) => error._tag === "PlatformError" && error.reason._tag === "NotFound",
        () => Effect.succeed(null),
      ),
    );
    if (watch?.relayOrigin === relayOrigin && watch.login === login && watch.taskId === taskId)
      return true;
  }
  return false;
});

const bookingNotice = (receipt: typeof SandboxReceipt.Type, now: number) => {
  switch (receipt.state) {
    case "starting":
      return {
        key: "starting",
        text: "Ask the owner to pair and join the sandbox Hub using their own sign-ins.",
      };
    case "running":
      if (receipt.endsAt && Date.parse(receipt.endsAt) - now <= 120_000)
        return {
          key: "expiring-" + receipt.endsAt,
          text: "The booking is near expiry. Push work and save Goal, Done and Next outside the sandbox. Release its claim with the saved note, sandboxId, out_of_usage and freeToContinue true.",
        };
      return {
        key: "running",
        text: "Route the task and hand-off note to the owner's matching sandbox Hub thread. Take there with taskId and sandboxId.",
      };
    case "ending":
    case "ended":
    case "cleanup_failed":
      return {
        key: "closed",
        text: "Save the latest hand-off note from this thread. Release the sandbox claim with sandboxId, the note, handing_over or out_of_usage and freeToContinue true. If it never claimed, there is nothing to release.",
      };
    default:
      return null;
  }
};

// A sandbox cannot complete its hand-off after its own Hub disappears. Wake the requesting thread on its original Hub.
export const refreshHandoffs = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const folder = yield* dir;
  const relays = yield* BanneretAgentRelays;
  const enrolment = yield* BanneretEnrolment;
  const threads = yield* ThreadManagementService;
  const refresh = Effect.fn("SandboxHandoff.refresh")(function* (file: string) {
    const watch = yield* fs.readFileString(file).pipe(Effect.flatMap(decodeWatch));
    const caller = yield* relays.forThread(watch.threadId);
    if (caller?.relayOrigin !== watch.relayOrigin || caller.me.login !== watch.login) return;
    const relay = yield* enrolment.relay(watch.relayOrigin);
    if (!relay) return;
    const receipt = yield* relay.sandbox({ kind: "read", id: watch.id });
    if (receipt.taskId !== watch.taskId) return;
    const notice = bookingNotice(receipt, DateTime.toEpochMillis(yield* DateTime.now));
    if (!notice || watch.delivered === notice.key) return;
    const key = "sandbox-" + relayHash([watch.relayOrigin, watch.id, notice.key].join("/"));
    yield* threads.sendToThread({
      threadId: watch.threadId,
      projectId: caller.projectId,
      commandId: CommandId.make(key),
      messageId: MessageId.make(key),
      text: (yield* encodeReceipt(receipt)) + "\n" + notice.text,
      attachments: [],
      mode: "queue",
      createdBy: "agent",
      creationSource: "mcp",
    });
    if (notice.key === "closed") yield* fs.remove(file);
    else yield* write({ ...watch, delivered: notice.key });
  });

  if (!(yield* fs.exists(folder))) return;
  for (const name of yield* fs.readDirectory(folder)) {
    if (!name.endsWith(".json")) continue;
    yield* refresh(path.join(folder, name)).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Sandbox hand-off refresh failed", cause)),
    );
  }
});
export const lifecycle = Layer.effectDiscard(
  refreshHandoffs.pipe(
    Effect.catchCause((cause) => Effect.logWarning("Sandbox hand-offs unavailable", cause)),
    Effect.andThen(Effect.sleep("10 seconds")),
    Effect.forever,
    Effect.forkScoped,
  ),
);
