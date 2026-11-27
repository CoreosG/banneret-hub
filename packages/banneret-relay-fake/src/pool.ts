// @effect-diagnostics globalDate:off nodeBuiltinImport:off - in-memory relay protocol fixture.
import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import type {
  PoolConfig,
  PoolCeilings,
  PoolHostFacts,
  PoolCurrent,
  PoolDirective,
  PoolLimitsPolicy,
  PoolSandbox,
  PoolSandboxRequest,
  PoolStateUpdate,
  PoolView,
  PoolWorkspace,
} from "@t3tools/contracts";

type Proof = {
  machineId: string;
  counter: string;
  sentAt: string;
  signature: string;
  bodyBase64: string;
};
type Booking = {
  owner: string;
  request: PoolSandboxRequest;
  proof: Proof;
  view: PoolSandbox;
  directive?: PoolDirective;
  deadline: number;
  offerId: string | null;
};
type PoolError =
  | "stale_offer"
  | "pool_limit_reached"
  | "level_not_offered"
  | "not_found"
  | "forbidden"
  | "malformed";

export function createPool(
  config: PoolConfig | undefined,
  fail: (code: PoolError, message: string, current?: PoolCurrent) => never,
) {
  const seconds = (duration: string) =>
    Number(duration.slice(0, -1)) *
    (duration.endsWith("h") ? 3600 : duration.endsWith("m") ? 60 : 1);
  const lifespan = seconds(config?.sandboxes.time_limit ?? "2h");
  const extension = seconds(config?.sandboxes.extend ?? "1h");
  const hosts = new Map<
    string,
    { facts: PoolHostFacts; received: number; policy: PoolLimitsPolicy }
  >();
  function smallerCapacity(a: string, b: string) {
    const bytes = (capacity: string) =>
      BigInt(capacity.slice(0, -1)) * 1024n ** BigInt("KMG".indexOf(capacity.slice(-1)) + 1);
    return bytes(a) <= bytes(b) ? a : b;
  }
  const overrides = new Map<string, PoolCeilings>();
  function requestedFor(host: string): PoolCeilings {
    const limits = config?.hosts.find((h) => h.id === host);
    if (!config || !limits) return fail("not_found", "Unknown host.");
    return overrides.get(host) ?? { limits, sizes: config.sandboxes.sizes };
  }
  function clamp(facts: PoolCeilings, requested: PoolCeilings): PoolCeilings {
    const local = facts.limits;
    const configured = requested.limits;
    const each = local.workspaces.each;
    const specified = configured.workspaces.each;
    const size = (key: "small" | "large") => {
      const hostSize = facts.sizes[key],
        relaySize = requested.sizes[key];
      return {
        cpu: Math.min(hostSize.cpu, relaySize.cpu),
        memory: smallerCapacity(hostSize.memory, relaySize.memory),
        disk: smallerCapacity(hostSize.disk, relaySize.disk),
      };
    };
    return {
      sizes: { small: size("small"), large: size("large") },
      limits: {
        id: local.id,
        level: local.level,
        sandbox_slots: {
          small: Math.min(local.sandbox_slots.small, configured.sandbox_slots.small),
          large: Math.min(local.sandbox_slots.large, configured.sandbox_slots.large),
        },
        workspaces: {
          max: Math.min(local.workspaces.max, configured.workspaces.max),
          each: {
            cpu: Math.min(each.cpu, specified.cpu),
            tasks: Math.min(each.tasks, specified.tasks),
            memory_floor: smallerCapacity(each.memory_floor, specified.memory_floor),
            memory_max: smallerCapacity(each.memory_max, specified.memory_max),
            disk: smallerCapacity(each.disk, specified.disk),
          },
        },
      },
    };
  }
  type Asked = { hostId: string; state: "asked" | "approved"; id: string; createdAt: string };
  const workspaces = new Map<string, Map<string, Asked>>();
  const bookings = new Map<string, Booking>();
  function directives(host: string) {
    const pending: PoolDirective[] = [];
    for (const b of bookings.values()) {
      if (b.request.hostId === host && b.directive) pending.push(b.directive);
      if (pending.length === 100) break;
    }
    return pending;
  }
  const waiting = (host: string) =>
    [...bookings.values()].filter((b) => b.request.hostId === host && b.view.state === "waiting");
  const refresh = () => {
    const now = Date.now();
    for (const b of bookings.values()) {
      if (b.view.state === "offered" && now >= b.deadline) {
        b.view = { ...b.view, state: "waiting" };
        b.offerId = null;
      }
      if (b.view.state === "waiting") {
        const place = waiting(b.request.hostId).indexOf(b) + 1;
        b.view = { ...b.view, place, waitSeconds: (place - 1) * lifespan };
      }
    }
  };
  const mustHost = (id: string) =>
    hosts.get(id) ?? fail("level_not_offered", "Host has not reported.");
  const owned = (owner: string, id: string) => {
    const b = bookings.get(id);
    return b?.owner === owner ? b : fail("not_found", "Unknown sandbox.");
  };
  return {
    founderHosts() {
      return (config?.hosts ?? []).map(({ id }) => {
        const report = hosts.get(id);
        return {
          requested: requestedFor(id),
          local: report ? { limits: report.facts.limits, sizes: report.facts.sizes } : null,
          effective: report ? { limits: report.policy.limits, sizes: report.policy.sizes } : null,
        };
      });
    },
    setLimits(requested: PoolCeilings) {
      const host = requested.limits.id;
      const report = mustHost(host);
      const each = requested.limits.workspaces.each;
      if (
        requested.limits.level !== report.facts.limits.level ||
        smallerCapacity(each.memory_floor, each.memory_max) !== each.memory_floor ||
        !NodeUtil.isDeepStrictEqual(clamp(requested, report.facts), requested)
      )
        return fail("pool_limit_reached", "Requested limits must fit the host ceilings.");
      overrides.set(host, requested);
      report.policy = { ...report.policy, ...requested };
    },
    requests() {
      return [...workspaces].flatMap(([personId, requests]) =>
        [...requests.values()].map((w) => ({
          personId,
          hostId: w.hostId,
          requestId: w.id,
          state: w.state,
        })),
      );
    },
    approve(id: string) {
      for (const mine of workspaces.values()) {
        for (const w of mine.values()) {
          if (w.id !== id) continue;
          if (w.state === "approved") return;
          const report = mustHost(w.hostId);
          const reserved = [...workspaces.values()].filter(
            (m) => m.get(w.hostId)?.state === "approved",
          ).length;
          if (
            report.facts.workspaces.filter((seat) => seat.state !== "removed").length + reserved >=
            report.policy.limits.workspaces.max
          )
            return fail("pool_limit_reached", "No workspace seats available.");
          w.state = "approved";
          return;
        }
      }
      return fail("not_found", "Unknown workspace request.");
    },
    report(host: string, facts: PoolHostFacts) {
      if (host !== facts.limits.id) fail("forbidden", "This token belongs to another host.");
      const configured = config?.hosts.find((h) => h.id === host);
      if (!config || !configured || configured.level !== facts.limits.level)
        return fail("level_not_offered", "Host level differs from relay configuration.");
      const policy = { ...clamp(facts, requestedFor(host)), warnings: config.warnings };
      for (const w of facts.workspaces) workspaces.get(w.personId)?.delete(host);
      hosts.set(host, { facts, received: Date.now(), policy });
      return { ...policy, directives: directives(host) };
    },
    ask(owner: string, hostId: string): PoolWorkspace {
      if (mustHost(hostId).facts.limits.level !== "staff")
        fail("level_not_offered", "Workspaces require a staff host.");
      const reported = mustHost(hostId).facts.workspaces.find((w) => w.personId === owner);
      if (reported) return { hostId, state: reported.state };
      const mine = workspaces.get(owner) ?? new Map<string, Asked>();
      if (!mine.has(hostId))
        mine.set(hostId, {
          hostId,
          state: "asked",
          id: NodeCrypto.randomUUID(),
          createdAt: new Date().toISOString(),
        });
      workspaces.set(owner, mine);
      return { hostId, state: mine.get(hostId)!.state };
    },
    needs() {
      return [...workspaces].flatMap(([owner, requests]) =>
        [...requests.values()]
          .filter((w) => w.state === "asked")
          .map((w) => ({
            id: w.id,
            createdAt: w.createdAt,
            kind: "workspace_request",
            title: `Workspace on ${w.hostId} requested by ${owner}`,
          })),
      );
    },
    list(owner: string): PoolView {
      refresh();
      const mine = new Map<string, PoolView["me"]["workspaces"][number]>();
      for (const w of workspaces.get(owner)?.values() ?? [])
        mine.set(w.hostId, { hostId: w.hostId, state: w.state, resources: null });
      const rows = (config?.hosts ?? []).map(({ id: hostId, level }) => {
        const report = hosts.get(hostId);
        if (!report)
          return {
            hostId,
            level,
            reporting: false,
            policy: null,
            contention: null,
            holders: [],
            line: [],
            heldCount: 0,
            waitingCount: 0,
          };
        const { facts, received } = report;
        const own = facts.workspaces.find((w) => w.personId === owner);
        if (own) mine.set(hostId, { hostId, state: own.state, resources: own.resources });

        const onHost = [...bookings.values()].filter((b) => b.request.hostId === hostId);
        const visible = (bs: Booking[]) =>
          level === "community"
            ? []
            : bs.map((b) => ({
                id: b.view.id,
                personId: b.owner,
                size: b.request.size,
                taskId: b.request.taskId ?? null,
              }));
        const held = onHost.filter((b) => b.view.state !== "waiting" && b.view.state !== "ended");
        const line = waiting(hostId);
        return {
          hostId,
          level,
          reporting: Date.now() - received < 120000,
          contention: facts.contention,
          policy: report.policy,
          holders: visible(held),
          line: visible(line),
          heldCount: held.length,
          waitingCount: line.length,
        };
      });
      return { hosts: rows, me: { workspaces: [...mine.values()] } };
    },
    enqueue(owner: string, request: PoolSandboxRequest, proof: Proof) {
      mustHost(request.hostId);
      refresh();
      if (!config?.sandboxes.images.some((i) => i.digest === request.image))
        fail("level_not_offered", "Unknown image digest.");
      if (
        [...bookings.values()].filter((b) => b.owner === owner && b.view.state === "waiting")
          .length >= (config?.sandboxes.per_person.waiting ?? 1)
      )
        fail("pool_limit_reached", "One waiting request per person.");
      const id = NodeCrypto.randomUUID();
      const view: PoolSandbox = {
        id,
        state: "waiting",
        place: waiting(request.hostId).length + 1,
        waitSeconds: waiting(request.hostId).length * lifespan,
        machineId: null,
        endsAt: null,
        reason: null,
      };
      bookings.set(id, { owner, request, view, proof, deadline: 0, offerId: null });
      return view;
    },
    next(host: string, size: "small" | "large") {
      refresh();
      const report = mustHost(host);
      const held = [...bookings.values()].filter(
        (b) =>
          b.offerId !== null &&
          b.request.hostId === host &&
          b.request.size === size &&
          b.view.state !== "ended",
      );
      const pending = held.filter((b) => b.view.state === "offered");
      if (
        Date.now() - report.received >= 120000 ||
        held.length >= report.policy.limits.sandbox_slots[size] ||
        pending.length >= report.facts.contention.freeSlots[size]
      )
        return { offer: null, directives: directives(host) };
      const b = waiting(host).find(
        (b) =>
          b.request.size === size &&
          [...bookings.values()].filter(
            (active) =>
              active.owner === b.owner &&
              active.view.state !== "waiting" &&
              active.view.state !== "ended",
          ).length < (config?.sandboxes.per_person.running ?? 1),
      );
      if (!b) return { offer: null, directives: directives(host) };
      b.deadline = Date.now() + 60000;
      b.offerId = NodeCrypto.randomUUID();
      b.view = { ...b.view, state: "offered", place: null, waitSeconds: null };
      return {
        directives: directives(host),
        offer: {
          id: b.view.id,
          offerId: b.offerId,
          personId: b.owner,
          deadline: new Date(b.deadline).toISOString(),
          ...b.proof,
        },
      };
    },
    read(owner: string, id: string) {
      refresh();
      return owned(owner, id).view;
    },
    cancel(owner: string, id: string) {
      refresh();
      const b = owned(owner, id);
      if (b.view.state === "cleanup_failed") fail("forbidden", "Cleanup needs an admin.");
      const unacknowledged = b.view.state === "waiting" || b.view.state === "offered";
      if (unacknowledged) b.offerId = null;
      if (b.offerId && (b.view.state === "starting" || b.view.state === "running"))
        b.directive = { sandboxId: id, offerId: b.offerId, action: "cancel" };
      if (b.view.state !== "ended")
        b.view = {
          ...b.view,
          state: unacknowledged ? "ended" : "ending",
          place: null,
          waitSeconds: null,
          reason: "cancelled",
        };
      return b.view;
    },
    extend(owner: string, id: string) {
      refresh();
      const b = owned(owner, id);
      if (
        !b.offerId ||
        b.view.state !== "running" ||
        !b.view.endsAt ||
        waiting(b.request.hostId).length
      )
        return fail("pool_limit_reached", "Extension unavailable.");
      const endsAt = new Date(Date.parse(b.view.endsAt) + extension * 1000).toISOString();
      b.directive = { sandboxId: id, offerId: b.offerId, action: "extend", endsAt };
      b.view = { ...b.view, endsAt };
      return b.view;
    },
    expireOffer(id: string) {
      const b = bookings.get(id);
      if (!b || b.view.state !== "offered") return fail("not_found", "Unknown offer.");
      b.deadline = 0;
      refresh();
    },
    update(host: string, id: string, event: PoolStateUpdate) {
      refresh();
      const b = bookings.get(id);
      if (!b || b.request.hostId !== host) return fail("not_found", "Unknown offer.");
      const current = {
        sandboxId: id,
        state: b.view.state,
        ...(b.offerId && { offerId: b.offerId }),
      };
      if (b.offerId !== event.offerId)
        return fail("stale_offer", "Offer is no longer current.", current);
      if (event.endsAt !== undefined) {
        if (
          b.view.state !== "running" ||
          event.state !== "running" ||
          event.endsAt !== b.view.endsAt ||
          event.machineId !== b.view.machineId
        )
          return fail("forbidden", "Extension does not match the running sandbox.", current);
        delete b.directive;
        return b.view;
      }
      if (event.state === "ending" && b.view.state === "ending") {
        delete b.directive;
        return b.view;
      }
      const allowed: Record<PoolSandbox["state"], readonly PoolStateUpdate["state"][]> = {
        waiting: [],
        offered: ["starting"],
        starting: ["running", "ending"],
        running: ["ending"],
        ending: ["ended", "cleanup_failed"],
        ended: [],
        cleanup_failed: ["ended"],
      };
      if (!allowed[b.view.state].includes(event.state))
        return fail("forbidden", "Invalid sandbox transition.", current);
      if (event.state === "running" && !event.machineId)
        fail("malformed", "Running needs a machine id.");
      delete b.directive;
      b.view = {
        ...b.view,
        state: event.state,
        machineId: event.machineId,
        reason: event.reason,
        endsAt:
          event.state === "running"
            ? new Date(Date.now() + lifespan * 1000).toISOString()
            : b.view.endsAt,
      };
      return b.view;
    },
  };
}
