import {
  ChatHandoffs,
  ChatSettings,
  IssueTrackerKind,
  type BanneretTaskRead,
  type ChannelAction,
  type ChannelResult,
  type Handoff,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { ProjectService } from "../../project/ProjectService.ts";
import { LeaseService, type LeaseServiceShape } from "../lease/LeaseService.ts";
import { sendTask } from "../Orchestrator.ts";
import type { RelayEnrolment as FullEnrolment } from "../relay/Enrolment.ts";
import { invalid } from "./AgentChat.ts";
import { verifyPushedWork } from "./pushedWork.ts";
import { handoffNote } from "./handoffNote.ts";

type RelayEnrolment = Pick<FullEnrolment, "origin" | "status" | "signedChat">;
const decodeSettings = Schema.decodeUnknownEffect(ChatSettings);
const decode = Schema.decodeUnknownEffect(ChatHandoffs);
type ReadTask = (id: string) => Effect.Effect<BanneretTaskRead>;
type Action = Extract<
  ChannelAction,
  { kind: "offerHandoff" | "acceptHandoff" | "advanceHandoff" | "withdrawHandoff" }
>;
const list = Effect.fn("Handoffs.list")(function* (relay: RelayEnrolment, state?: string) {
  const offers: Handoff[] = [];
  let cursor: string | null = null;
  do {
    const page: ChatHandoffs = yield* relay
      .signedChat(
        "GET",
        "handoffs?limit=100" +
          (state ? "&state=" + state : "") +
          (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
      )
      .pipe(Effect.flatMap((r) => decode(r.body)));
    offers.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return offers;
});

const taskRef = Effect.fn("Handoffs.taskRef")(function* (
  relay: RelayEnrolment,
  read: ReadTask,
  id: string,
) {
  const task = (yield* read(id)).value?.task;
  if (!task) return yield* invalid("The hand-off task is unavailable.");
  return {
    tracker: IssueTrackerKind.make(task.ref.tracker),
    host: task.ref.host ?? "github.com",
    scope: task.ref.scope,
    key: task.ref.key,
    relayOrigin: relay.origin,
  };
});

// The relay persists consent and the tracker persists ownership. The Hub only serializes live writes.
// Offered -> accept, decline, withdraw, expiry or void. Only acceptance permits a lease change.
// Accepted + giver holds -> release. Accepted + free -> take and read back. A standing claim closes done or lost.
// Restart reads accepted rows again. A stalled row uses the same checked step as automatic reconciliation.
export const makeHandoffs = Effect.gen(function* () {
  const leases = yield* LeaseService;
  const projects = yield* ProjectService;
  const context = yield* Effect.context<Effect.Services<ReturnType<typeof sendTask>>>();
  return handoffsForMachine(leases, projects, (input, task) =>
    sendTask(input, task).pipe(Effect.provideContext(context)),
  );
});

export function handoffsForMachine(
  leases: LeaseServiceShape,
  projects: Pick<ProjectService["Service"], "listShells">,
  dispatch: (
    input: Parameters<typeof sendTask>[0],
    task: Parameters<typeof sendTask>[1],
  ) => Effect.Effect<unknown, { message: string }>,
) {
  const lock = Semaphore.makeUnsafe(1);
  const advance = Effect.fn("Handoffs.advance")(function* (
    relay: RelayEnrolment,
    read: ReadTask,
    h: Handoff,
  ) {
    const { me, machineId } = yield* relay.status;
    if (!me || h.state !== "accepted") return;
    const give =
      h.step === "waiting_release" && me.id === h.from.id && machineId === h.fromMachineId;
    const take =
      h.step === "waiting_take" && me.id === h.to.id && (!h.machineId || machineId === h.machineId);
    if (!give && !take) return;
    const ref = yield* taskRef(relay, read, h.taskId);
    const current = yield* leases.check(ref);
    if (
      give &&
      current.actions.release &&
      current.lease?.holder.toLowerCase() === h.from.login.toLowerCase()
    ) {
      yield* leases.release({
        ...ref,
        reason: "handing_over",
        reasonText: "to @" + h.to.login,
        freeToContinue: true,
        note: yield* handoffNote(h.note),
      });
    } else if (take && current.actions.take && !current.lease) {
      const input = { ...ref, handoffTaskId: h.taskId };
      const result = yield* leases.take(input);
      if (result.handoff) yield* dispatch(input, result.handoff);
    }
  });
  const accept = Effect.fn("Handoffs.accept")(function* (
    relay: RelayEnrolment,
    read: ReadTask,
    h: Handoff,
    byRule: boolean,
  ) {
    const { me, machineId } = yield* relay.status;
    if (h.state !== "offered" || !machineId || me?.id !== h.to.id)
      return yield* invalid("Only the named receiver can accept an open offer.");
    const current = yield* leases.check(yield* taskRef(relay, read, h.taskId));
    if (
      current.availability !== "available" ||
      current.busy ||
      current.lease?.state !== "active" ||
      current.lease.holder.toLowerCase() !== h.from.login.toLowerCase()
    )
      return yield* invalid(
        current.detail ?? "Check the tracker account and current holder before accepting.",
      );
    return (yield* relay.signedChat("POST", "handoffs/" + h.id + "/accept", {
      machineId,
      ...(byRule && { byRule: true }),
    })).body;
  });
  const reconcile = (relay: RelayEnrolment, read: ReadTask) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const { me } = yield* relay.status;
          if (!me) return;
          for (const h of yield* list(relay, "accepted"))
            yield* advance(relay, read, h).pipe(
              Effect.catch((e) => Effect.logWarning("Hand-off still waiting", h.id, e.message)),
            );
          const incoming = (yield* list(relay, "offered")).filter((h) => h.to.id === me.id);
          if (!incoming.length) return;
          const settings = yield* relay
            .signedChat("GET", "me/settings")
            .pipe(Effect.flatMap((r) => decodeSettings(r.body)));
          if (settings.agentsPaused || settings.agentAsks.default === "off") return;
          for (const h of incoming)
            if (
              settings.agentAsks.auto.some(
                (r) =>
                  "person" in r.from &&
                  r.from.person.id === h.from.id &&
                  r.kinds.some((k) => k === "handoff"),
              )
            )
              yield* accept(relay, read, h, true).pipe(Effect.ignore);
        }),
      )
      .pipe(Effect.ignore);
  const act = (
    relay: RelayEnrolment,
    read: ReadTask,
    action: Action,
  ): Effect.Effect<ChannelResult> =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          if (action.kind === "offerHandoff") {
            const o = action.offer;
            const ref = yield* taskRef(relay, read, o.taskId);
            if (!(yield* leases.check(ref)).actions.release)
              return yield* invalid("You must hold this task to offer it.");
            yield* handoffNote(o.note);
            yield* verifyPushedWork(yield* projects.listShells(), ref, o.branch, o.headSha);
            if (!o.threadRootId) yield* relay.signedChat("PUT", "tasks/" + o.taskId + "/thread");
            return (yield* relay.signedChat("POST", "handoffs", o)).body;
          }
          const h = (yield* list(relay)).find((row) => row.id === action.id);
          if (!h) return yield* invalid("The offer is unavailable.");
          if (action.kind === "withdrawHandoff")
            return (yield* relay.signedChat("POST", "handoffs/" + h.id + "/withdraw", {})).body;
          if (action.kind === "advanceHandoff") {
            yield* advance(relay, read, h);
            return h;
          }
          return yield* accept(relay, read, h, false);
        }),
      )
      .pipe(
        Effect.match({
          onSuccess: (value) => ({ ok: true as const, value }),
          onFailure: (e) => ({ ok: false as const, message: e.message }),
        }),
      );
  return { act, reconcile };
}
