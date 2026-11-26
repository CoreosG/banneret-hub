// @effect-diagnostics nodeBuiltinImport:off - the suite makes random ids with node:crypto.
import * as NodeCrypto from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { RelayClient, rfc3339, SseReader, type Reply } from "./client.ts";
import { type FakeRelay, startFakeRelay } from "./fake.ts";
import { generateMachineKey, keyFromSeed, type MachineKey } from "./signing.ts";
import { listExamples, loadSpec, readExample } from "./spec.ts";

/**
 * The /relay/v1 conformance suite. It speaks HTTP only, so it runs against any relay:
 * - by default, a fake relay started here on an ephemeral port;
 * - with BANNERET_RELAY_URL=<origin>, that relay, which must expose the /conformance/v1 control surface and run
 *   without the network identity check (see docs/banneret/relay-v1/FAKE.md).
 */
const external = process.env.BANNERET_RELAY_URL;
const spec = loadSpec();

let fake: FakeRelay | undefined;
let client: RelayClient;

beforeAll(async () => {
  if (external) {
    client = new RelayClient(external);
    return;
  }
  fake = await startFakeRelay({ autoApprove: false, retryAfterMs: 0 });
  client = new RelayClient(fake.url);
});

afterAll(async () => {
  await fake?.close();
});

const vectorSeed = Uint8Array.from({ length: 32 }, (_, index) => index);
const randomText = (bytes: number) => NodeCrypto.randomBytes(bytes).toString("hex");
const newLogin = () => `c-${randomText(5)}`;

const machineFacts = (environmentId: string, label = "Conformance server") => ({
  environmentId,
  label,
  kind: "server",
  hostname: "conformance-host",
  os: "Ubuntu 24.04",
  hubVersion: "0.4.2",
  policyFingerprint: null,
  sandbox: { enabled: false, image: null },
});

const expectSchema = (schema: string, body: unknown) => {
  expect(spec.check(schema, body), `${schema}: ${JSON.stringify(body)}`).toBeNull();
};

const expectError = (reply: Reply, status: number, code: string) => {
  expect(reply.status, JSON.stringify(reply.body)).toBe(status);
  expectSchema("Error", reply.body);
  expect((reply.body as { error: { code: string } }).error.code).toBe(code);
};

interface Started {
  readonly key: MachineKey;
  readonly environmentId: string;
  readonly pairingId: string;
  readonly confirmCode: string;
  readonly expiresAt: string;
}

const startPairing = async (environmentId = `env_${NodeCrypto.randomUUID()}`): Promise<Started> => {
  const key = generateMachineKey();
  const reply = await client.send(key, "POST", "/relay/v1/enroll/start", {
    body: { publicKey: key.publicKey, machine: machineFacts(environmentId) },
  });
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  expectSchema("EnrolStartResponse", reply.body);
  const body = reply.body as { pairingId: string; confirmCode: string; expiresAt: string };
  return { key, environmentId, ...body };
};

const poll = async (started: Started) => {
  const reply = await client.send(started.key, "POST", "/relay/v1/enroll/poll", {
    body: { pairingId: started.pairingId },
  });
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  expectSchema("EnrolPollResponse", reply.body);
  return reply.body as {
    state: string;
    expiresAt: string;
    machineId?: string;
    token?: string;
    reason?: string;
  };
};

const confirm = (started: Started, person: Record<string, unknown>, code = started.confirmCode) =>
  client.control(`/pairings/${started.pairingId}/confirm`, { code, person });

interface Enrolled {
  readonly key: MachineKey;
  readonly environmentId: string;
  readonly machineId: string;
  readonly token: string;
  readonly login: string;
}

const enrol = async (
  options: { login?: string; role?: "founder" | "limited_staff"; environmentId?: string } = {},
): Promise<Enrolled> => {
  const login = options.login ?? newLogin();
  const started = await startPairing(options.environmentId);
  await confirm(started, { login, role: options.role ?? "founder" });
  const approved = await poll(started);
  expect(approved.state).toBe("approved");
  if (approved.token === undefined || approved.machineId === undefined) {
    throw new Error("approved without a token");
  }
  return {
    key: started.key,
    environmentId: started.environmentId,
    machineId: approved.machineId,
    token: approved.token,
    login,
  };
};

const call = (machine: Enrolled, method: string, target: string, body?: unknown) =>
  client.send(machine.key, method, target, {
    token: machine.token,
    device: machine.machineId,
    ...(body === undefined ? {} : { body }),
  });

const openEvents = async (machine: Enrolled, lastEventId?: string) => {
  const response = await client.raw(machine.key, "GET", "/relay/v1/events", {
    token: machine.token,
    device: machine.machineId,
    ...(lastEventId === undefined ? {} : { headers: { "Last-Event-ID": lastEventId } }),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toMatch(/^text\/event-stream/);
  return new SseReader(response);
};

const EVENT_SCHEMAS: Record<string, string> = {
  "needs.changed": "NeedsChangedEvent",
  mention: "MentionEvent",
  "bundle.changed": "BundleChangedEvent",
  "staff.removed": "StaffRemovedEvent",
  "capabilities.changed": "CapabilitiesChangedEvent",
};

const nextEvent = async (reader: SseReader) => {
  const event = await reader.next();
  if (!event) throw new Error("the event stream closed");
  expect(event.id).toBeDefined();
  expectSchema(EVENT_SCHEMAS[event.event] ?? "unknown event", event.data);
  return event;
};

describe("capabilities", () => {
  it("answers anyone with the public document only", async () => {
    const reply = await client.send(generateMachineKey(), "GET", "/relay/v1/capabilities", {
      unsigned: true,
    });
    expect(reply.status).toBe(200);
    expectSchema("Capabilities", reply.body);
    expect(Object.keys(reply.body as object).toSorted()).toEqual(
      ["displayName", "enrolment", "iconUrl", "protocol"].toSorted(),
    );
    expect(reply.headers.get("etag")).toBeTruthy();
  });

  it("adds me, sections, tools and adapters for an enrolled caller", async () => {
    const machine = await enrol();
    const reply = await call(machine, "GET", "/relay/v1/capabilities");
    expect(reply.status).toBe(200);
    expectSchema("Capabilities", reply.body);
    const body = reply.body as { me: { login: string; machineId?: string }; sections: unknown[] };
    expect(body.me.login).toBe(machine.login);
    expect(body.me.machineId).toBe(machine.machineId);
    expect(Array.isArray(body.sections)).toBe(true);
  });
});

describe("capabilities with a failing token", () => {
  it("refuses a token sent without a signature instead of falling back", async () => {
    const machine = await enrol();
    const reply = await client.send(machine.key, "GET", "/relay/v1/capabilities", {
      token: machine.token,
      device: machine.machineId,
      unsigned: true,
    });
    expectError(reply, 401, "unauthenticated");
  });

  it("refuses an unknown token", async () => {
    const machine = await enrol();
    const reply = await client.send(machine.key, "GET", "/relay/v1/capabilities", {
      token: `rdt_${randomText(24)}`,
      device: machine.machineId,
    });
    expectError(reply, 401, "unauthenticated");
  });
});

describe("enrolment", () => {
  it("goes pending, approved, then hands out the token exactly once", async () => {
    const started = await startPairing();
    expect(started.confirmCode).toMatch(/^[A-Z2-7]{8}$/);
    expect((await poll(started)).state).toBe("pending");
    await confirm(started, { login: newLogin(), role: "founder" });
    const first = await poll(started);
    expect(first.state).toBe("approved");
    expect(first.token).toBeDefined();
    const second = await poll(started);
    expect(second.state).toBe("approved");
    expect(second.machineId).toBe(first.machineId);
    expect(second.token).toBeUndefined();
  });

  it("holds a person new to the relay in awaiting_approval for 7 days until a founder approves", async () => {
    const started = await startPairing();
    await confirm(started, { login: newLogin(), awaitFounder: true });
    const waiting = await poll(started);
    expect(waiting.state).toBe("awaiting_approval");
    expect(waiting.token).toBeUndefined();
    const extended = Date.parse(waiting.expiresAt) - Date.parse(started.expiresAt);
    expect(extended).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
    await client.control(`/pairings/${started.pairingId}/approve`);
    expect((await poll(started)).state).toBe("approved");
  });

  it.each(["declined", "not_staff"])("reports a %s refusal as a poll state", async (reason) => {
    const started = await startPairing();
    await client.control(`/pairings/${started.pairingId}/refuse`, { reason });
    const refused = await poll(started);
    expect(refused).toMatchObject({ state: "refused", reason });
    expect(refused.token).toBeUndefined();
  });

  it("reports an expired code as a poll state", async () => {
    const started = await startPairing();
    await client.control(`/pairings/${started.pairingId}/expire`);
    expect(await poll(started)).toMatchObject({ state: "expired", reason: "code_expired" });
  });

  it("reports an expired approval as a poll state", async () => {
    const started = await startPairing();
    await confirm(started, { login: newLogin(), awaitFounder: true });
    await client.control(`/pairings/${started.pairingId}/expire`);
    expect(await poll(started)).toMatchObject({ state: "expired", reason: "approval_expired" });
  });

  it("expires a pairing after 5 wrong codes", async () => {
    const started = await startPairing();
    const person = { login: newLogin(), role: "founder" };
    const wrong = started.confirmCode === "AAAAAAAA" ? "BBBBBBBB" : "AAAAAAAA";
    const states: unknown[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      states.push((await confirm(started, person, wrong)).state);
    }
    expect(states).toEqual(["pending", "pending", "pending", "pending", "expired"]);
    await confirm(started, person);
    expect(await poll(started)).toMatchObject({ state: "expired", reason: "too_many_attempts" });
  });

  it("refuses an environment that another person already enrolled", async () => {
    const first = await enrol();
    const started = await startPairing(first.environmentId);
    await confirm(started, { login: newLogin(), role: "founder" });
    expect(await poll(started)).toMatchObject({
      state: "refused",
      reason: "environment_enrolled",
    });
    expect((await call(first, "GET", "/relay/v1/today")).status).toBe(200);
  });

  it("replaces the old machine when its owner enrols the environment again", async () => {
    const first = await enrol();
    const second = await enrol({ login: first.login, environmentId: first.environmentId });
    expect(second.machineId).not.toBe(first.machineId);
    expectError(await call(first, "GET", "/relay/v1/machines"), 401, "token_revoked");
    expect((await call(second, "GET", "/relay/v1/machines")).status).toBe(200);
  });

  it("refuses a poll for an unknown pairing", async () => {
    const key = generateMachineKey();
    const reply = await client.send(key, "POST", "/relay/v1/enroll/poll", {
      body: { pairingId: `pr_${randomText(6)}` },
    });
    expectError(reply, 404, "not_found");
  });

  it("refuses a poll signed with a key other than the pairing's", async () => {
    const started = await startPairing();
    const reply = await client.send(generateMachineKey(), "POST", "/relay/v1/enroll/poll", {
      body: { pairingId: started.pairingId },
    });
    expectError(reply, 401, "signature_invalid");
  });

  it.each(listExamples("invalid/").filter((file) => file.startsWith("enroll-start")))(
    "refuses invalid start example %s with malformed",
    async (file) => {
      // Signed with the examples' own key, so only the body is at fault.
      const reply = await client.send(keyFromSeed(vectorSeed), "POST", "/relay/v1/enroll/start", {
        body: readExample(`invalid/${file}`),
      });
      expectError(reply, 400, "malformed");
    },
  );
});

describe("request signing", () => {
  it("refuses a signature over different bytes", async () => {
    const machine = await enrol();
    const reply = await client.send(machine.key, "GET", "/relay/v1/needs?limit=5", {
      token: machine.token,
      device: machine.machineId,
      signOverride: { target: "/relay/v1/needs?limit=6" },
    });
    expectError(reply, 401, "signature_invalid");
  });

  it("refuses a sending time more than 2 minutes off and accepts one inside the window", async () => {
    const machine = await enrol();
    const options = { token: machine.token, device: machine.machineId };
    const now = Date.parse(client.now());
    const late = await client.send(machine.key, "GET", "/relay/v1/today", {
      ...options,
      sentAt: rfc3339(now - 3 * 60 * 1000),
    });
    expectError(late, 401, "clock_skew");
    const early = await client.send(machine.key, "GET", "/relay/v1/today", {
      ...options,
      sentAt: rfc3339(now + 3 * 60 * 1000),
    });
    expectError(early, 401, "clock_skew");
    const inside = await client.send(machine.key, "GET", "/relay/v1/today", {
      ...options,
      sentAt: rfc3339(now - 60 * 1000),
    });
    expect(inside.status).toBe(200);
  });

  it("refuses a counter among the last 256 accepted or below the lowest of them", async () => {
    const machine = await enrol();
    const options = { token: machine.token, device: machine.machineId };
    const counter = BigInt(client.nextCounter());
    const send = (value: bigint) =>
      client.send(machine.key, "GET", "/relay/v1/today", { ...options, counter: value.toString() });
    expect((await send(counter)).status).toBe(200);
    expectError(await send(counter), 401, "counter_reused");
    expectError(await send(counter - 1n), 401, "counter_reused");
    expect((await send(counter + 10n)).status).toBe(200);
    // Out of order but above the lowest accepted: concurrent requests may arrive like this.
    expect((await send(counter + 5n)).status).toBe(200);
    expectError(await send(counter + 5n), 401, "counter_reused");
    // 254 more make 257 accepted, so `counter` leaves the window and the lowest becomes counter + 5.
    const statuses = new Set<number>();
    for (let step = 11n; step < 265n; step += 1n) statuses.add((await send(counter + step)).status);
    expect([...statuses]).toEqual([200]);
    expectError(await send(counter + 3n), 401, "counter_reused");
  });

  it("refuses a call without a device token", async () => {
    const machine = await enrol();
    const reply = await client.send(machine.key, "GET", "/relay/v1/machines", {
      device: machine.machineId,
      counter: client.nextCounter(),
    });
    expectError(reply, 401, "unauthenticated");
  });

  it("refuses a device header that names another machine", async () => {
    const machine = await enrol();
    const other = await enrol();
    const reply = await client.send(machine.key, "GET", "/relay/v1/machines", {
      token: machine.token,
      device: other.machineId,
    });
    expectError(reply, 401, "unauthenticated");
  });
});

describe("facts", () => {
  const facts = (machine: Enrolled, name = "facts-request.json") => {
    const body = readExample(name) as { machine: { environmentId: string } };
    body.machine.environmentId = machine.environmentId;
    return body;
  };

  it("accepts a heartbeat and shows it in the machines list", async () => {
    const machine = await enrol();
    const reply = await call(machine, "POST", "/relay/v1/facts", facts(machine));
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expectSchema("FactsResponse", reply.body);
    const listed = await call(machine, "GET", "/relay/v1/machines?limit=100");
    expectSchema("MachinesPage", listed.body);
    const own = (
      listed.body as { items: Array<{ id: string; lastHeardAt: string | null; label: string }> }
    ).items.find((item) => item.id === machine.machineId);
    expect(own).toMatchObject({ label: "Ada server", connected: true });
    expect(own?.lastHeardAt).not.toBeNull();
  });

  it.each(listExamples("invalid/").filter((file) => file.startsWith("facts-")))(
    "refuses invalid example %s with malformed",
    async (file) => {
      const machine = await enrol();
      expectError(
        await call(machine, "POST", "/relay/v1/facts", facts(machine, `invalid/${file}`)),
        400,
        "malformed",
      );
    },
  );
});

describe("paging", () => {
  it("pages needs-you items with cursor and limit", async () => {
    const machine = await enrol();
    await client.control("/needs", { machineId: machine.machineId, count: 5 });
    const pages: number[] = [];
    const ids: string[] = [];
    let target: string | null = "/relay/v1/needs?limit=2";
    while (target !== null) {
      const reply: Reply = await call(machine, "GET", target);
      expect(reply.status).toBe(200);
      expectSchema("NeedsPage", reply.body);
      const body = reply.body as { items: Array<{ id: string }>; nextCursor: string | null };
      pages.push(body.items.length);
      ids.push(...body.items.map((item) => item.id));
      target =
        body.nextCursor === null
          ? null
          : `/relay/v1/needs?limit=2&cursor=${encodeURIComponent(body.nextCursor)}`;
    }
    expect(pages).toEqual([2, 2, 1]);
    expect(new Set(ids).size).toBe(5);
  });

  it("continues Today's needs-you block in GET /needs", async () => {
    const machine = await enrol();
    await client.control("/needs", { machineId: machine.machineId, count: 25 });
    const today = await call(machine, "GET", "/relay/v1/today");
    expectSchema("Today", today.body);
    const block = (
      today.body as { needsYou: { items: Array<{ id: string }>; nextCursor: string | null } }
    ).needsYou;
    expect(block.items).toHaveLength(20);
    expect(block.nextCursor).not.toBeNull();
    const rest = await call(
      machine,
      "GET",
      `/relay/v1/needs?cursor=${encodeURIComponent(block.nextCursor ?? "")}`,
    );
    expectSchema("NeedsPage", rest.body);
    const restIds = (rest.body as { items: Array<{ id: string }> }).items.map((item) => item.id);
    expect(restIds).toHaveLength(5);
    expect(restIds.some((id) => block.items.some((item) => item.id === id))).toBe(false);
  });

  it("pages the machines list without repeats", async () => {
    const owner = await enrol();
    const others = [await enrol(), await enrol()];
    const seen: string[] = [];
    let target: string | null = "/relay/v1/machines?limit=1";
    while (target !== null) {
      const reply: Reply = await call(owner, "GET", target);
      expectSchema("MachinesPage", reply.body);
      const body = reply.body as { items: Array<{ id: string }>; nextCursor: string | null };
      expect(body.items.length).toBeLessThanOrEqual(1);
      seen.push(...body.items.map((item) => item.id));
      target =
        body.nextCursor === null
          ? null
          : `/relay/v1/machines?limit=1&cursor=${encodeURIComponent(body.nextCursor)}`;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(
      expect.arrayContaining([owner.machineId, ...others.map((other) => other.machineId)]),
    );
  });

  it.each(["limit=0", "limit=101", "limit=two", "cursor=not-a-cursor"])(
    "refuses %s",
    async (query) => {
      const machine = await enrol();
      expectError(await call(machine, "GET", `/relay/v1/needs?${query}`), 400, "malformed");
    },
  );
});

describe("events", () => {
  it("delivers needs.changed and mention to the person's stream", async () => {
    const machine = await enrol();
    const reader = await openEvents(machine);
    await client.control("/needs", { machineId: machine.machineId, count: 1, kind: "mention" });
    const mention = await nextEvent(reader);
    expect(mention.event).toBe("mention");
    const changed = await nextEvent(reader);
    expect(changed.event).toBe("needs.changed");
    expect(changed.data).toMatchObject({ count: 1 });
    await reader.cancel();
  });

  it("replays from Last-Event-ID", async () => {
    const machine = await enrol();
    const reader = await openEvents(machine);
    await client.control("/needs", { machineId: machine.machineId, count: 1 });
    const first = await nextEvent(reader);
    await reader.cancel();
    await client.control("/needs", { machineId: machine.machineId, count: 1 });
    const resumed = await openEvents(machine, first.id);
    const replayed = await nextEvent(resumed);
    expect(replayed.event).toBe("needs.changed");
    expect(replayed.data).toMatchObject({ count: 2 });
    await resumed.cancel();
  });

  it("asks the client to refetch when it cannot resume", async () => {
    const machine = await enrol();
    const reader = await openEvents(machine, "unknown-event-id");
    const names = [(await nextEvent(reader)).event, (await nextEvent(reader)).event];
    expect(names).toEqual(["needs.changed", "capabilities.changed"]);
    await reader.cancel();
  });
});

describe("revocation", () => {
  it("refuses a revoked machine everywhere, capabilities included, and closes its stream", async () => {
    const machine = await enrol();
    const reader = await openEvents(machine);
    const revoke = await call(machine, "DELETE", `/relay/v1/machines/${machine.machineId}`);
    expect(revoke.status).toBe(204);
    // The spec allows up to a minute; the fake refuses at once.
    expect(await reader.next()).toBeNull();
    expectError(await call(machine, "GET", "/relay/v1/machines"), 401, "token_revoked");
    expectError(await call(machine, "GET", "/relay/v1/capabilities"), 401, "token_revoked");
    const listed = await call(await enrol(), "GET", "/relay/v1/machines?limit=100");
    const ids = (listed.body as { items: Array<{ id: string }> }).items.map((item) => item.id);
    expect(ids).not.toContain(machine.machineId);
  });

  it("lets a founder revoke another's machine, answers 204 again, and forbids limited staff", async () => {
    const target = await enrol({ role: "limited_staff" });
    const staff = await enrol({ role: "limited_staff" });
    expectError(
      await call(staff, "DELETE", `/relay/v1/machines/${target.machineId}`),
      403,
      "forbidden",
    );
    const founder = await enrol({ role: "founder" });
    expect((await call(founder, "DELETE", `/relay/v1/machines/${target.machineId}`)).status).toBe(
      204,
    );
    expect((await call(founder, "DELETE", `/relay/v1/machines/${target.machineId}`)).status).toBe(
      204,
    );
  });

  it("answers not_found for an unknown machine", async () => {
    const founder = await enrol();
    expectError(
      await call(founder, "DELETE", `/relay/v1/machines/m_${randomText(6)}`),
      404,
      "not_found",
    );
  });
});

describe("empty store", () => {
  // A relay under test cannot be restarted from here; this proves the fake's own cold start.
  it.skipIf(external !== undefined)("starts empty and serves every read", async () => {
    const fresh = await startFakeRelay({ autoApprove: false, retryAfterMs: 0 });
    try {
      const freshClient = new RelayClient(fresh.url);
      const anonymous = await freshClient.send(
        generateMachineKey(),
        "GET",
        "/relay/v1/capabilities",
        {
          unsigned: true,
        },
      );
      expect(anonymous.status).toBe(200);
      const key = generateMachineKey();
      const start = await freshClient.send(key, "POST", "/relay/v1/enroll/start", {
        body: { publicKey: key.publicKey, machine: machineFacts(`env_${randomText(4)}`) },
      });
      const { pairingId, confirmCode } = start.body as { pairingId: string; confirmCode: string };
      fresh.approve(confirmCode, { login: "first-person", role: "founder" });
      const approved = (
        await freshClient.send(key, "POST", "/relay/v1/enroll/poll", { body: { pairingId } })
      ).body as { machineId: string; token: string };
      const options = { token: approved.token, device: approved.machineId };
      const machinesReply = await freshClient.send(key, "GET", "/relay/v1/machines", options);
      expectSchema("MachinesPage", machinesReply.body);
      expect((machinesReply.body as { items: unknown[] }).items).toHaveLength(1);
      const needsReply = await freshClient.send(key, "GET", "/relay/v1/needs", options);
      expect(needsReply.body).toEqual({ items: [], nextCursor: null });
      const todayReply = await freshClient.send(key, "GET", "/relay/v1/today", options);
      expectSchema("Today", todayReply.body);
      expect(todayReply.body).toMatchObject({
        lastVisitAt: null,
        needsYou: { items: [], nextCursor: null },
      });
    } finally {
      await fresh.close();
    }
  });
});

describe("network identity check", () => {
  // Optional in the spec and off by default; only the fake can be switched on from here.
  it.skipIf(external !== undefined)(
    "refuses a mismatch at confirmation and on later calls",
    async () => {
      const header = "X-Test-Network-Identity";
      const checked = await startFakeRelay({ autoApprove: false, networkIdentityHeader: header });
      try {
        const checkedClient = new RelayClient(checked.url);
        const startAs = async (identity: string) => {
          const key = generateMachineKey();
          const reply = await checkedClient.send(key, "POST", "/relay/v1/enroll/start", {
            body: { publicKey: key.publicKey, machine: machineFacts(`env_${randomText(4)}`) },
            headers: { [header]: identity },
          });
          return { key, ...(reply.body as { pairingId: string; confirmCode: string }) };
        };
        const pollAs = async (started: { key: MachineKey; pairingId: string }) =>
          (
            await checkedClient.send(started.key, "POST", "/relay/v1/enroll/poll", {
              body: { pairingId: started.pairingId },
            })
          ).body as { state: string; reason?: string; machineId: string; token: string };

        const mismatched = await startAs("node-b");
        checked.approve(mismatched.confirmCode, {
          login: "ada-example",
          networkIdentity: "node-a",
        });
        expect(await pollAs(mismatched)).toMatchObject({
          state: "refused",
          reason: "network_identity_mismatch",
        });

        const matched = await startAs("node-a");
        checked.approve(matched.confirmCode, { login: "ada-example", networkIdentity: "node-a" });
        const approved = await pollAs(matched);
        expect(approved.state).toBe("approved");
        const options = { token: approved.token, device: approved.machineId };
        const good = await checkedClient.send(matched.key, "GET", "/relay/v1/today", {
          ...options,
          headers: { [header]: "node-a" },
        });
        expect(good.status).toBe(200);
        const bad = await checkedClient.send(matched.key, "GET", "/relay/v1/today", {
          ...options,
          headers: { [header]: "node-b" },
        });
        expectError(bad, 403, "network_identity_mismatch");
      } finally {
        await checked.close();
      }
    },
  );
});
