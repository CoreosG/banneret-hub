// Banneret Hub: the provider switch notice. It reads provider profiles and the thread's own records,
// never a provider's files, and writes nothing. It keeps no state.
import {
  PROVIDER_DISPLAY_NAMES,
  providerHandoffEnds,
  TaskLeaseError,
  type ContextHandoffId,
  type EnvironmentId,
  type OrchestrationV2ThreadProjection,
  type ProviderDriverKind,
  type ProviderSwitchSide,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
// By path: a package dependency would add a line to an upstream manifest.
import {
  builtInProviderProfileIds,
  providerProfile,
  unknownProviderProfile,
  type ProviderProfile,
} from "../../../../../packages/banneret-plugin-kit/src/providerProfile/index.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { hubServes, memoryAccess } from "./access.ts";
import type { PromptHook } from "./promptHook.ts";
import { switchNoteText } from "./switchNote.ts";

const profileOf = (driver: ProviderDriverKind): ProviderProfile =>
  builtInProviderProfileIds.includes(driver)
    ? providerProfile(driver)
    : unknownProviderProfile(driver, PROVIDER_DISPLAY_NAMES[driver] ?? driver);

const list = (names: ReadonlyArray<string>, last: "and" | "or") =>
  names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} ${last} ${names.at(-1)}`;

const rule = (names: ReadonlyArray<string>, take: "all" | "firstNonEmpty") =>
  list(names, take === "all" ? "and" : "or");

/** The file names a profile says its provider looks for. A part that is not known stays null. */
export function switchSide(driver: ProviderDriverKind): ProviderSwitchSide {
  const profile = profileOf(driver);
  const { instructions } = profile;
  const { names, fallback } = instructions.project;
  let project: string | null = null;
  if ("value" in names && "value" in fallback) {
    project = rule(names.value.names, names.value.take);
    if (fallback.value.when === "noPrimaryFileOnTheWalk") {
      project += `. ${list(fallback.value.names, "and")} only when none of these is found`;
    } else if (fallback.value.when === "afterPrimaryNamesInEachFolder") {
      if (fallback.value.names.length) project += `, then ${list(fallback.value.names, "or")}`;
    }
  }
  const { homeFolder, user } = instructions;
  const personal =
    "value" in homeFolder && "value" in user
      ? rule(
          user.value.names.map((name) => `${homeFolder.value.path}/${name}`),
          user.value.take,
        )
      : null;
  return {
    name: profile.name,
    integrated: project !== null && personal !== null,
    project,
    personal,
  };
}

/** The note count, only for a chat whose agent gets the note index from banneret://join. */
const indexedNotes = Effect.fn("BanneretMemory.indexedNotes")(
  function* (threadId: ThreadId, environment: EnvironmentId) {
    if (!(yield* hubServes(threadId, environment, "memory"))) return null;
    const access = yield* memoryAccess(threadId, environment);
    if (!access.orchestrator) return null;
    // The watcher mode never waits for a lock, so a turn cannot stall here, and starts no git copy.
    return yield* access.open((store) => store.counts(access.main).total, "watcher");
  },
  Effect.catchCause(() => Effect.succeed(null)),
);

export const switchNotice = Effect.fn("BanneretMemory.switchNotice")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly from: ProviderDriverKind;
    readonly to: ProviderDriverKind;
    readonly handoffId?: ContextHandoffId | undefined;
  }) {
    const environment = yield* (yield* ServerEnvironment).getEnvironmentId;
    const handoff =
      input.handoffId === undefined
        ? undefined
        : (yield* (yield* ThreadManagementService).getThreadRecords(input.threadId, [
            "contextHandoffs",
          ])).contextHandoffs.find((candidate) => candidate.id === input.handoffId);
    const history = handoff?.history;
    return {
      from: switchSide(input.from),
      to: switchSide(input.to),
      notes: yield* indexedNotes(input.threadId, environment),
      // Delivery can drop more than the handoff did, so what was delivered wins.
      carried: history
        ? {
            items: handoff.delivery?.itemIds.length ?? history.messages.length,
            of: history.messages.length + history.omittedItems,
          }
        : null,
    };
  },
  Effect.mapError((e) => new TaskLeaseError({ reason: "unavailable", detail: e.message })),
);

/** The change of provider a run's handoff records, or null when the provider stayed the same. */
export function runSwitch(
  records: Pick<OrchestrationV2ThreadProjection, "turnItems" | "runs" | "providerThreads">,
  runId: RunId,
) {
  const item = records.turnItems.findLast(
    (candidate) => candidate.type === "handoff" && candidate.runId === runId,
  );
  if (item?.type !== "handoff") return null;
  const ends = providerHandoffEnds(item, records.runs);
  if (!ends) return null;
  const driverOf = (instance: typeof ends.from) =>
    records.providerThreads.find((thread) => thread.providerInstanceId === instance)?.driver;
  const from = driverOf(ends.from);
  const to = driverOf(ends.to);
  return from === undefined || to === undefined || from === to
    ? null
    : { item, from, to, resumed: ends.resumed };
}

/** The note for the first turn of a run that moved the thread to another provider. */
const switchContextNotes = (change: ReturnType<typeof runSwitch>, noteIndex: boolean) =>
  change
    ? [
        {
          // One key for each switch: adapters skip a note they have already sent under a key.
          key: `banneret_switch_${change.item.ordinal}`,
          text: switchNoteText({
            from: profileOf(change.from).name,
            resumed: change.resumed,
            noteIndex,
          }),
          updatedAt: DateTime.formatIso(change.item.updatedAt),
        },
      ]
    : [];

export const setupSwitchNote = Effect.gen(function* () {
  const threads = yield* ThreadManagementService;
  const environment = yield* (yield* ServerEnvironment).getEnvironmentId;
  const note = Effect.fn("BanneretMemory.switchNote")(
    function* (threadId: ThreadId, runId: RunId) {
      // Most runs have no handoff, so only the run's own items are read first.
      const { turnItems } = yield* threads.getThreadRecords(threadId, ["turnItems"], {
        turnItemRunId: runId,
      });
      if (!turnItems.some((item) => item.type === "handoff")) return [];
      const records = yield* threads.getThreadRecords(threadId, ["runs", "providerThreads"]);
      const change = runSwitch({ ...records, turnItems }, runId);
      return change
        ? switchContextNotes(change, (yield* indexedNotes(threadId, environment)) !== null)
        : [];
    },
    Effect.catchCause(() => Effect.succeed([])),
  );
  const context = yield* Effect.context<Effect.Services<ReturnType<typeof note>>>();
  const hook: PromptHook = (thread, run) => note(thread, run).pipe(Effect.provideContext(context));
  return hook;
});
