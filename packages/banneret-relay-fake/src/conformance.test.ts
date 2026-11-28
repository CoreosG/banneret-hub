// @effect-diagnostics nodeBuiltinImport:off - the suite makes random ids with node:crypto.
import * as NodeCrypto from "node:crypto";

import type {
  RelayOwners,
  RelaySource,
  PoolConfig,
  PoolHostFacts,
  PoolFounderView,
  PoolSandbox,
  PoolNextResponse,
  PoolView,
} from "@t3tools/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { RelayClient, rfc3339, SseReader, type Reply } from "./client.ts";
import { type FakeRelay, startFakeRelay } from "./fake.ts";
import {
  generateMachineKey,
  keyFromSeed,
  publicKeyFromBase64,
  verify,
  type MachineKey,
} from "./signing.ts";
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
  fake = await startFakeRelay({
    autoApprove: false,
    retryAfterMs: 0,
    chat: {
      agentAsks: { enabled: true },
      handoffs: { enabled: true, stallAfter: "1s" },
      reviews: { enabled: true },
    },
    skills: [
      {
        name: "publish",
        description: "Publish a release.",
        text: "---\nname: publish\ndescription: Publish a release.\n---\nVerify the release.",
        locked: true,
      },
    ],
    pool: readExample("pool-config.json") as PoolConfig,
  });
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

const startPairing = async (
  environmentId = `env_${NodeCrypto.randomUUID()}`,
  poolHostId?: string,
): Promise<Started> => {
  const key = generateMachineKey();
  const reply = await client.send(key, "POST", "/relay/v1/enroll/start", {
    body: {
      publicKey: key.publicKey,
      machine: { ...machineFacts(environmentId), ...(poolHostId ? { poolHostId } : {}) },
    },
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
  options: {
    login?: string;
    role?: string;
    admission?: "member" | "outside";
    repoKeys?: readonly string[];
    environmentId?: string;
    poolHostId?: string;
  } = {},
): Promise<Enrolled> => {
  const login = options.login ?? newLogin();
  const started = await startPairing(options.environmentId, options.poolHostId);
  await confirm(started, {
    login,
    role: options.role ?? (options.admission === "outside" ? "outside" : "founder"),
    admission: options.admission,
    repoKeys: options.repoKeys,
  });
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

/** The head's `boards` index, read and validated; undefined when the head names none. */
const readBoardsIndex = async (machine: Enrolled, files: Readonly<Record<string, string>>) => {
  const ref = files.boards;
  if (ref === undefined) return undefined;
  const reply = await call(machine, "GET", `/relay/v1/snapshot/files/${ref.slice(7)}`);
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  expectSchema("SnapshotBoards", reply.body);
  return reply.body as {
    boards: Array<{ id: string; title: string; mode: string; counts: Record<string, number> }>;
  };
};

/** The head ref of the first board in the index: a `board/seed` without `boards` lands there. */
const firstBoardRef = async (machine: Enrolled, files: Readonly<Record<string, string>>) => {
  const first = (await readBoardsIndex(machine, files))?.boards[0];
  return first === undefined ? undefined : files[`board.${first.id}`];
};

interface ListedMachine {
  readonly ownerId: string;
  readonly id: string;
  readonly connected: boolean;
  readonly lastHeardAt?: string | null;
  readonly revocable?: boolean;
  readonly revokedAt?: string;
}

/** Every machine the caller sees, through every page. */
const listMachines = async (machine: Enrolled): Promise<ListedMachine[]> => {
  const seen: ListedMachine[] = [];
  let target: string | null = "/relay/v1/machines?limit=100";
  while (target !== null) {
    const reply: Reply = await call(machine, "GET", target);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expectSchema("MachinesPage", reply.body);
    const body = reply.body as { items: ListedMachine[]; nextCursor: string | null };
    seen.push(...body.items);
    target =
      body.nextCursor === null
        ? null
        : `/relay/v1/machines?limit=100&cursor=${encodeURIComponent(body.nextCursor)}`;
  }
  return seen;
};

const factsFor = (machine: Enrolled, name = "facts-request.json") => {
  const body = readExample(name) as { machine: { environmentId: string } };
  body.machine.environmentId = machine.environmentId;
  return body;
};

const openEvents = (machine: Enrolled, lastEventId?: string) =>
  client.events(machine.key, machine.token, machine.machineId, lastEventId);

const EVENT_SCHEMAS: Record<string, string> = {
  "team.changed": "TeamChangedEvent",
  "team.rooms_changed": "TeamRoomsChangedEvent",
  "chat.changed": "ChatChangedEvent",
  "chat.delivery": "ChatDeliveryEvent",
  "needs.changed": "NeedsChangedEvent",
  mention: "MentionEvent",
  "bundle.changed": "BundleChangedEvent",
  "staff.removed": "StaffRemovedEvent",
  "capabilities.changed": "CapabilitiesChangedEvent",
  reset: "ResetEvent",
};

const nextEvent = async (reader: SseReader) => {
  const event = await reader.next();
  if (!event) throw new Error("the event stream closed");
  if (event.event.startsWith("chat.") || event.event.startsWith("team."))
    expect(event.id).toBeUndefined();
  else expect(event.id).toBeDefined();
  expectSchema(EVENT_SCHEMAS[event.event] ?? "unknown event", event.data);
  return event;
};

describe("capabilities", () => {
  it("decodes the enrolled response served before capability ownership", () => {
    const legacy = readExample("capabilities.json");
    expect(legacy).toHaveProperty("me");
    expect(legacy).not.toHaveProperty("owners");
    expect(legacy).not.toHaveProperty("sources");
    expectSchema("Capabilities", legacy);
  });

  it.each(["off", "external"] as const)(
    "hides chat and task tools with chat owned by %s",
    async (owner) => {
      const example = readExample("capabilities-external.json") as {
        owners: RelayOwners;
        sources: RelaySource[];
      };
      const source = { ...example.sources[0]!, provides: ["tasks", "chat"] as const };
      const owners: RelayOwners = {
        ...example.owners,
        chat: owner === "off" ? { owner } : { owner, source: source.id },
      };
      const relay = await startFakeRelay({ chat: true, owners, sources: [source] });
      try {
        const local = new RelayClient(relay.url);
        const key = generateMachineKey();
        const start = await local.send(key, "POST", "/relay/v1/enroll/start", {
          body: { publicKey: key.publicKey, machine: machineFacts("env_" + randomText(12)) },
        });
        const { pairingId } = start.body as { pairingId: string };
        const poll = await local.send(key, "POST", "/relay/v1/enroll/poll", {
          body: { pairingId },
        });
        const { token, machineId } = poll.body as { token: string; machineId: string };
        const read = (path: string) =>
          local.send(key, "GET", "/relay/v1/" + path, { token, device: machineId });
        const reply = await read("capabilities");
        expectSchema("Capabilities", reply.body);
        expect(reply.body).toMatchObject({ owners, sources: [source] });
        expect(reply.body).not.toHaveProperty("chat");
        const names = (reply.body as { mcpTools: { name: string }[] }).mcpTools.map(
          (tool) => tool.name,
        );
        expect(names).toContain("banneret_needs");
        expect(names).toContain("banneret_team");
        expect(
          names.filter((name) => /^banneret_(board|task|lease_|chat_|agent_|handoff_)/.test(name)),
        ).toEqual([]);
        expectError(await read("chat/conversations"), 404, "not_found");
      } finally {
        await relay.close();
      }
    },
  );

  it("answers anyone with the public document only", async () => {
    const reply = await client.send(generateMachineKey(), "GET", "/relay/v1/capabilities", {
      unsigned: true,
    });
    expect(reply.status).toBe(200);
    expectSchema("Capabilities", reply.body);
    expect(Object.keys(reply.body as object).toSorted()).toEqual(
      ["displayName", "enrolment", "iconUrl"].toSorted(),
    );
    expect(reply.headers.get("etag")).toMatch(/^"[^"]+"$/);
  });

  it("sends the ETag as capabilitiesVersion in double quotes", async () => {
    const machine = await enrol();
    const facts = await call(machine, "POST", "/relay/v1/facts", factsFor(machine));
    expect(facts.status, JSON.stringify(facts.body)).toBe(200);
    const version = (facts.body as { capabilitiesVersion: string }).capabilitiesVersion;
    expect(version.startsWith('"')).toBe(false);
    const reply = await call(machine, "GET", "/relay/v1/capabilities");
    expect(reply.status).toBe(200);
    expect(reply.headers.get("etag")).toBe(`"${version}"`);
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
    if ("skills" in body) {
      expect(body.skills).toEqual({ registry: true });
      const catalog = await call(machine, "GET", "/relay/v1/skills");
      expect(catalog.status).toBe(200);
      expectSchema("SkillsCatalog", catalog.body);
    } else expect(external).toBeTruthy();
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
    expectError(reply, 401, "bad_signature");
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
  /** A pairing approved for a new founder, not yet polled. */
  const approvedPairing = async () => {
    const started = await startPairing();
    await confirm(started, { login: newLogin(), role: "founder" });
    return started;
  };

  const capabilitiesWith = (started: Started, machineId: string, token: string) =>
    client.send(started.key, "GET", "/relay/v1/capabilities", { token, device: machineId });

  it("goes pending, then approved with a machine id and a token", async () => {
    const started = await startPairing();
    expect(started.confirmCode).toMatch(/^[A-Z2-7]{8}$/);
    expect((await poll(started)).state).toBe("pending");
    await confirm(started, { login: newLogin(), role: "founder" });
    const approved = await poll(started);
    expect(approved.state).toBe("approved");
    expect(approved.machineId).toBeDefined();
    expect(approved.token).toBeDefined();
  });

  it("returns a fresh token on each poll after approval until one is used", async () => {
    const started = await approvedPairing();
    const first = await poll(started);
    const second = await poll(started);
    expect(second.state).toBe("approved");
    expect(second.machineId).toBe(first.machineId);
    expect(first.token).toBeDefined();
    expect(second.token).toBeDefined();
    expect(second.token).not.toBe(first.token);
  });

  it("accepts only the latest re-issued token", async () => {
    const started = await approvedPairing();
    const first = await poll(started);
    const second = await poll(started);
    const machineId = second.machineId!;
    expectError(await capabilitiesWith(started, machineId, first.token!), 401, "unauthenticated");
    expect((await capabilitiesWith(started, machineId, second.token!)).status).toBe(200);
  });

  it("stops returning a token after the first authenticated call", async () => {
    const started = await approvedPairing();
    const approved = await poll(started);
    expect((await capabilitiesWith(started, approved.machineId!, approved.token!)).status).toBe(
      200,
    );
    const after = await poll(started);
    expect(after.state).toBe("approved");
    expect(after.machineId).toBe(approved.machineId);
    expect(after.token).toBeUndefined();
    // The used token keeps working.
    expect((await capabilitiesWith(started, approved.machineId!, approved.token!)).status).toBe(
      200,
    );
  });

  it("refuses an older token as unauthenticated once a newer one was used", async () => {
    const started = await approvedPairing();
    const older = await poll(started);
    const latest = await poll(started);
    const machineId = latest.machineId!;
    expect((await capabilitiesWith(started, machineId, latest.token!)).status).toBe(200);
    expectError(await capabilitiesWith(started, machineId, older.token!), 401, "unauthenticated");
    expect((await poll(started)).token).toBeUndefined();
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
    const login = newLogin();
    await client.control(`/pairings/${started.pairingId}/refuse`, { reason, login });
    const refused = await poll(started);
    expect(refused).toMatchObject({ state: "refused", reason, account: { login } });
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

  it("expires a pairing on the 5th wrong code, with expiresAt the time of that attempt", async () => {
    const started = await startPairing();
    const person = { login: newLogin(), role: "founder" };
    const wrong = started.confirmCode === "AAAAAAAA" ? "BBBBBBBB" : "AAAAAAAA";
    const states: unknown[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      states.push((await confirm(started, person, wrong)).state);
    }
    expect(states).toEqual(["pending", "pending", "pending", "pending", "expired"]);
    await confirm(started, person);
    const expired = await poll(started);
    expect(expired).toMatchObject({ state: "expired", reason: "too_many_attempts" });
    // Measured on the relay's own clock: the start was 10 minutes before the code's expiry, and the 5th
    // attempt came within seconds of it, so expiresAt sits just after the start, not at the code's expiry.
    const startedAt = Date.parse(started.expiresAt) - 10 * 60 * 1000;
    const expiresAt = Date.parse(expired.expiresAt);
    expect(expiresAt).toBeGreaterThanOrEqual(startedAt - 1000);
    expect(expiresAt).toBeLessThan(startedAt + 60 * 1000);
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

  it("refuses an enrolment call with a non-zero counter as bad_signature", async () => {
    const key = generateMachineKey();
    const reply = await client.send(key, "POST", "/relay/v1/enroll/start", {
      body: { publicKey: key.publicKey, machine: machineFacts(`env_${NodeCrypto.randomUUID()}`) },
      counter: "1",
    });
    expectError(reply, 401, "bad_signature");
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

  it("keeps the 256 highest counters: refuses a repeat or one below them, accepts the rest", async () => {
    const machine = await enrol();
    const options = { token: machine.token, device: machine.machineId };
    const counter = BigInt(client.nextCounter());
    const send = (value: bigint) =>
      client.send(machine.key, "GET", "/relay/v1/today", { ...options, counter: value.toString() });
    expect((await send(counter)).status).toBe(200);
    expectError(await send(counter), 401, "counter_reused");
    // Fewer than 256 seen: anything that is not a repeat is accepted, even below the lowest.
    expect((await send(counter - 1n)).status).toBe(200);
    expectError(await send(counter - 1n), 401, "counter_reused");
    expect((await send(counter + 10n)).status).toBe(200);
    // Out of order: concurrent requests may arrive like this.
    expect((await send(counter + 5n)).status).toBe(200);
    expectError(await send(counter + 5n), 401, "counter_reused");
    // 252 more make 256 accepted: counter - 1, counter, counter + 5, counter + 10 .. counter + 262.
    const statuses = new Set<number>();
    for (let step = 11n; step <= 262n; step += 1n)
      statuses.add((await send(counter + step)).status);
    expect([...statuses]).toEqual([200]);
    // Full: the 256th highest is counter - 1, so anything below it is refused.
    expectError(await send(counter - 2n), 401, "counter_reused");
    // A gap above the lowest is accepted, and pushes the lowest (counter - 1) out of the window.
    expect((await send(counter + 1n)).status).toBe(200);
    expectError(await send(counter - 1n), 401, "counter_reused");
    expect((await send(counter + 2n)).status).toBe(200);
    // Now the lowest is counter + 1, so counter is below the window.
    expectError(await send(counter), 401, "counter_reused");
    expect((await send(counter + 3n)).status).toBe(200);
  });

  it("accepts the int64 maximum counter and refuses one above it as bad_signature", async () => {
    const machine = await enrol();
    const options = { token: machine.token, device: machine.machineId };
    const over = await client.send(machine.key, "GET", "/relay/v1/today", {
      ...options,
      counter: "9223372036854775808",
    });
    expectError(over, 401, "bad_signature");
    const twenty = await client.send(machine.key, "GET", "/relay/v1/today", {
      ...options,
      counter: "10000000000000000000",
    });
    expectError(twenty, 401, "bad_signature");
    const max = await client.send(machine.key, "GET", "/relay/v1/today", {
      ...options,
      counter: "9223372036854775807",
    });
    expect(max.status, JSON.stringify(max.body)).toBe(200);
  });

  it.each([
    ["a malformed sending time", { sentAt: "2026-11-26 10:00:00" }],
    ["a malformed signature", { headers: { "X-Banneret-Signature": "not-a-signature" } }],
    ["a missing signature", { headers: { "X-Banneret-Signature": "" } }],
    ["a malformed counter", { counter: "01" }],
  ])("refuses %s as bad_signature", async (_name, override) => {
    const machine = await enrol();
    const reply = await client.send(machine.key, "GET", "/relay/v1/today", {
      token: machine.token,
      device: machine.machineId,
      ...override,
    });
    expectError(reply, 401, "bad_signature");
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
  const facts = factsFor;

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

  it("forbids an environmentId other than the token's machine", async () => {
    const machine = await enrol();
    const other = await enrol({ login: machine.login });
    const body = facts(machine);
    body.machine.environmentId = other.environmentId;
    expectError(await call(machine, "POST", "/relay/v1/facts", body), 403, "forbidden");
  });

  it("accepts a body of exactly 1 MiB and refuses one byte more with too_large", async () => {
    const machine = await enrol();
    const json = JSON.stringify(facts(machine));
    const sized = (bytes: number) =>
      Buffer.from(json + " ".repeat(bytes - Buffer.byteLength(json, "utf8")), "utf8");
    const send = (rawBody: Buffer) =>
      client.send(machine.key, "POST", "/relay/v1/facts", {
        token: machine.token,
        device: machine.machineId,
        rawBody,
      });
    const limit = await send(sized(1024 * 1024));
    expect(limit.status, JSON.stringify(limit.body)).toBe(200);
    expectError(await send(sized(1024 * 1024 + 1)), 413, "too_large");
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

  it("rejects visit recording and invalid since timestamps", async () => {
    const machine = await enrol();
    for (const query of ["visit=1", "since=yesterday"]) {
      expectError(await call(machine, "GET", `/relay/v1/today?${query}`), 400, "malformed");
    }
  });

  describe("usage in facts", () => {
    const usageFacts = (machine: Enrolled, usage: unknown) => ({
      machine: machineFacts(machine.environmentId),
      activity: [],
      usage,
    });

    it("accepts valid usage and stores it", async () => {
      const machine = await enrol();
      const example = readExample("facts-request.json") as { usage: unknown[] };
      const body = usageFacts(machine, example.usage);
      const reply = await call(machine, "POST", "/relay/v1/facts", body);
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      expectSchema("FactsResponse", reply.body);
      const stored = (await client.control("/usage", { machineId: machine.machineId })) as {
        usage: unknown[];
      };
      expect(stored.usage).toEqual(example.usage);
    });

    it("accepts facts without usage", async () => {
      const machine = await enrol();
      const reply = await call(machine, "POST", "/relay/v1/facts", {
        machine: machineFacts(machine.environmentId),
        activity: [],
      });
      expect(reply.status).toBe(200);
    });

    it.each(["facts-usage-extra-field.json", "facts-usage-percent-over-100.json"])(
      "refuses the invalid example %s",
      async (file) => {
        const machine = await enrol();
        const body = readExample(`invalid/${file}`) as { machine: Record<string, unknown> };
        const reply = await call(machine, "POST", "/relay/v1/facts", {
          ...body,
          machine: machineFacts(machine.environmentId),
        });
        expectError(reply, 400, "malformed");
      },
    );
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

  it("ranks an agent_message above a suggestion", async () => {
    const machine = await enrol();
    for (const kind of ["suggestion", "agent_message"]) {
      await client.control("/needs", { machineId: machine.machineId, count: 1, kind });
    }
    const needs = await call(machine, "GET", "/relay/v1/needs");
    expectSchema("NeedsPage", needs.body);
    const items = (needs.body as { items: Array<{ kind: string }> }).items;
    expect(items.map((item) => item.kind)).toEqual(["agent_message", "suggestion"]);
  });

  it("orders needs-you by class, then oldest first, in GET /needs and Today", async () => {
    const machine = await enrol();
    for (const kind of [
      "thread_approval",
      "suggestion",
      "mention",
      "pull_request",
      "thread_question",
    ]) {
      await client.control("/needs", { machineId: machine.machineId, count: 1, kind });
    }
    const expected = [
      "thread_approval",
      "thread_question",
      "pull_request",
      "mention",
      "suggestion",
    ];
    const needs = await call(machine, "GET", "/relay/v1/needs");
    expectSchema("NeedsPage", needs.body);
    const items = (needs.body as { items: Array<{ kind: string; createdAt: string }> }).items;
    expect(items.map((item) => item.kind)).toEqual(expected);
    // Within class 1 the older item comes first.
    expect(Date.parse(items[0]?.createdAt ?? "")).toBeLessThanOrEqual(
      Date.parse(items[1]?.createdAt ?? ""),
    );
    const today = await call(machine, "GET", "/relay/v1/today");
    expectSchema("Today", today.body);
    const block = (today.body as { needsYou: { items: Array<{ kind: string }> } }).needsYou;
    expect(block.items.map((item) => item.kind)).toEqual(expected);
  });

  it.each(["limit=0", "limit=101", "limit=two", "cursor=not-a-cursor"])(
    "refuses %s",
    async (query) => {
      const machine = await enrol();
      expectError(await call(machine, "GET", `/relay/v1/needs?${query}`), 400, "malformed");
    },
  );
});

describe("repositories", () => {
  it("lists the company repositories to a signed caller", async () => {
    const machine = await enrol();
    await client.control("/repositories", { count: 2 });
    const reply = await call(machine, "GET", "/relay/v1/repositories?limit=100");
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expectSchema("RepositoriesPage", reply.body);
    const items = (reply.body as { items: Array<{ projectKey: string; name: string }> }).items;
    expect(items.length).toBeGreaterThanOrEqual(2);
  });

  it("refuses an unsigned call with bad_signature", async () => {
    const machine = await enrol();
    const reply = await client.send(machine.key, "GET", "/relay/v1/repositories", {
      token: machine.token,
      device: machine.machineId,
      unsigned: true,
    });
    expectError(reply, 401, "bad_signature");
  });

  it("refuses a call without a device token", async () => {
    const machine = await enrol();
    const reply = await client.send(machine.key, "GET", "/relay/v1/repositories", {
      device: machine.machineId,
      counter: client.nextCounter(),
    });
    expectError(reply, 401, "unauthenticated");
  });

  it("pages with cursor and limit without repeats", async () => {
    const machine = await enrol();
    await client.control("/repositories", { count: 5 });
    const seen: string[] = [];
    let target: string | null = "/relay/v1/repositories?limit=2";
    let pages = 0;
    while (target !== null) {
      const reply: Reply = await call(machine, "GET", target);
      expect(reply.status).toBe(200);
      expectSchema("RepositoriesPage", reply.body);
      const body = reply.body as {
        items: Array<{ projectKey: string }>;
        nextCursor: string | null;
      };
      expect(body.items.length).toBeLessThanOrEqual(2);
      seen.push(...body.items.map((item) => item.projectKey));
      pages += 1;
      target =
        body.nextCursor === null
          ? null
          : `/relay/v1/repositories?limit=2&cursor=${encodeURIComponent(body.nextCursor)}`;
    }
    expect(pages).toBeGreaterThanOrEqual(3);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("validates the example and refuses the invalid ones", () => {
    expectSchema("RepositoriesPage", readExample("repositories.json"));
    const invalid = listExamples("invalid/").filter((file) => file.startsWith("repositories-"));
    expect(invalid.length).toBeGreaterThan(0);
    for (const file of invalid) {
      expect(spec.check("RepositoriesPage", readExample(`invalid/${file}`))).not.toBeNull();
    }
  });
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

  it("is live only without Last-Event-ID", async () => {
    const machine = await enrol();
    await client.control("/needs", { machineId: machine.machineId, count: 1 });
    const reader = await openEvents(machine);
    await client.control("/needs", { machineId: machine.machineId, count: 1 });
    const first = await nextEvent(reader);
    expect(first.event).toBe("needs.changed");
    expect(first.data).toMatchObject({ count: 2 });
    await reader.cancel();
  });

  it("sends one reset for an unknown Last-Event-ID, then continues live", async () => {
    const machine = await enrol();
    const reader = await openEvents(machine, "unknown-event-id");
    expect((await nextEvent(reader)).event).toBe("reset");
    await client.control("/needs", { machineId: machine.machineId, count: 1 });
    const next = await nextEvent(reader);
    expect(next.event).toBe("needs.changed");
    expect(next.data).toMatchObject({ count: 1 });
    await reader.cancel();
  });

  it("sends reset when the resume point is more than 1000 events back", async () => {
    const machine = await enrol();
    const reader = await openEvents(machine);
    await client.control("/needs", { machineId: machine.machineId, count: 1 });
    const first = await nextEvent(reader);
    await reader.cancel();
    // 1001 mention events for this person, then needs.changed.
    await client.control("/needs", { machineId: machine.machineId, count: 1001, kind: "mention" });
    const resumed = await openEvents(machine, first.id);
    expect((await nextEvent(resumed)).event).toBe("reset");
    await client.control("/needs", { machineId: machine.machineId, count: 1 });
    const next = await nextEvent(resumed);
    expect(next.event).toBe("needs.changed");
    expect(next.data).toMatchObject({ count: 1003 });
    await resumed.cancel();
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
  });

  it("lets a founder revoke another's machine, answers 204 again, and forbids limited staff", async () => {
    const target = await enrol({ role: "staff" });
    const staff = await enrol({ role: "staff" });
    expectError(
      await call(staff, "DELETE", `/relay/v1/machines/${target.machineId}`),
      404,
      "not_found",
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

  it.each(["bad.id", "x".repeat(65)])(
    "answers not_found, never 400, for malformed id %s",
    async (id) => {
      const founder = await enrol();
      expectError(await call(founder, "DELETE", `/relay/v1/machines/${id}`), 404, "not_found");
    },
  );
});

describe("machine visibility", () => {
  it("shows named machines to colleagues, and a revoked one only to its owner and founders", async () => {
    const owner = await enrol({ role: "staff" });
    const ownerOther = await enrol({ login: owner.login, role: "staff" });
    const founderMachine = await enrol({ role: "founder" });
    const staff = await enrol({ role: "staff" });

    expect((await listMachines(staff)).map((m) => m.id)).not.toContain(owner.machineId);
    const facts = factsFor(owner);
    await call(owner, "POST", "/relay/v1/facts", {
      ...facts,
      machine: { ...facts.machine, share: "agents_and_name" },
    });
    expect((await listMachines(staff)).find((m) => m.id === owner.machineId)).toBeUndefined();
    expectError(
      await call(staff, "DELETE", `/relay/v1/machines/${owner.machineId}`),
      404,
      "not_found",
    );
    expect((await call(owner, "DELETE", `/relay/v1/machines/${owner.machineId}`)).status).toBe(204);
    expectError(
      await call(staff, "DELETE", `/relay/v1/machines/${owner.machineId}`),
      404,
      "not_found",
    );

    const ids = (view: ListedMachine[]) => view.map((item) => item.id);
    expect(ids(await listMachines(staff))).not.toContain(owner.machineId);
    for (const viewer of [ownerOther, founderMachine]) {
      const view = await listMachines(viewer);
      const revoked = view.find((item) => item.id === owner.machineId);
      expect(revoked).toMatchObject({ connected: false, revocable: false });
      expect(revoked?.revokedAt).toMatch(/Z$/);
      // Revoked machines follow every live one.
      const index = view.findIndex((item) => item.id === owner.machineId);
      expect(view.slice(index).every((item) => item.revokedAt !== undefined)).toBe(true);
    }
  });
});

describe("snapshot", () => {
  const SNAPSHOT_SCHEMAS: Record<string, string> = {
    needs: "SnapshotNeeds",
    health: "HealthBlock",
    work: "SnapshotWork",
    machines: "SnapshotMachines",
    repositories: "SnapshotRepositories",
  };
  const sha256 = (bytes: Buffer) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  const bare = (ref: string) => ref.slice("sha256:".length);

  interface RawReply {
    readonly status: number;
    readonly headers: Headers;
    readonly bytes: Buffer;
  }
  // The exact response bytes: a file's name is the hash of them.
  const callBytes = async (
    machine: Enrolled,
    target: string,
    headers?: Record<string, string>,
  ): Promise<RawReply> => {
    const response = await client.raw(machine.key, "GET", target, {
      token: machine.token,
      device: machine.machineId,
      ...(headers === undefined ? {} : { headers }),
    });
    return {
      status: response.status,
      headers: response.headers,
      bytes: Buffer.from(await response.arrayBuffer()),
    };
  };
  const json = (reply: RawReply): unknown => JSON.parse(reply.bytes.toString("utf8"));

  interface Head {
    readonly generatedAt: string;
    readonly files: Record<string, string>;
  }
  const readHead = async (machine: Enrolled, headers?: Record<string, string>) => {
    const reply = await callBytes(machine, "/relay/v1/snapshot/head", headers);
    expect(reply.status, reply.bytes.toString("utf8")).toBe(200);
    const head = json(reply) as Head;
    expectSchema("SnapshotHead", head);
    return { reply, head };
  };
  const readFile = (machine: Enrolled, hash: string) =>
    callBytes(machine, `/relay/v1/snapshot/files/${hash}`);
  const expectNotFound = (reply: RawReply) => {
    expectError(
      { status: reply.status, headers: reply.headers, body: json(reply) },
      404,
      "not_found",
    );
  };
  // The rebuild control forces the new head; the poll only absorbs a relay that applies it asynchronously.
  const POLL = { timeout: 20_000, interval: 100 };
  const needsRefAfterSeed = async (machine: Enrolled, previous: string) => {
    await client.control("/needs", { machineId: machine.machineId, count: 1 });
    // A relay with a rebuild interval honours this in test mode, so the head moves without waiting.
    await client.rebuildSnapshot(machine.login);
    await expect
      .poll(async () => (await readHead(machine)).head.files.needs ?? previous, POLL)
      .not.toBe(previous);
    return (await readHead(machine)).head.files.needs ?? previous;
  };

  it("advertises the snapshot to an enrolled caller, and not to anyone else", async () => {
    const machine = await enrol();
    const reply = await call(machine, "GET", "/relay/v1/capabilities");
    expect(reply.status).toBe(200);
    expectSchema("Capabilities", reply.body);
    const body = reply.body as {
      snapshot?: { version: number; head: string };
    };
    expect(body.snapshot?.version).toBeGreaterThanOrEqual(1);
    expect(body.snapshot?.head).toBe("/relay/v1/snapshot/head");
    const anonymous = await client.send(generateMachineKey(), "GET", "/relay/v1/capabilities", {
      unsigned: true,
    });
    expect((anonymous.body as { snapshot?: unknown }).snapshot).toBeUndefined();
  });

  it("lists files in the head, and each file fetches with a matching sha256", async () => {
    const machine = await enrol();
    await client.control("/repositories", { count: 2 });
    await client.control("/needs", { machineId: machine.machineId, count: 2 });
    await client.rebuildSnapshot(machine.login);
    const { reply, head } = await readHead(machine);
    expect(reply.headers.get("etag")).toBe(`"sha256:${sha256(reply.bytes)}"`);
    expect(reply.headers.get("cache-control")).toBe("private, no-cache");
    for (const kind of ["needs", "work", "machines"]) {
      expect(head.files[kind], kind).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    const fetched: Record<string, unknown> = {};
    for (const [kind, ref] of Object.entries(head.files)) {
      const schema = SNAPSHOT_SCHEMAS[kind];
      if (schema === undefined) continue;
      const file = await readFile(machine, bare(ref));
      expect(file.status, `${kind}: ${file.bytes.toString("utf8")}`).toBe(200);
      expect(sha256(file.bytes), kind).toBe(bare(ref));
      expect(file.headers.get("etag")).toBe(`"${ref}"`);
      expect(file.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
      fetched[kind] = json(file);
      expectSchema(schema, fetched[kind]);
    }
    // The same facts as the live calls, to the same caller.
    const live = await call(machine, "GET", "/relay/v1/today");
    expect(fetched.needs).toEqual((live.body as { needsYou: unknown }).needsYou);
    expect(Object.keys(fetched.work as object).toSorted()).toEqual(["stuck", "working"]);
    const listed = (await listMachines(machine)).map((m) => m.id);
    const shared = (fetched.machines as { items: Array<{ id: string }> }).items.map((m) => m.id);
    expect(listed).toEqual(expect.arrayContaining(shared));
    expect(shared).not.toContain(machine.machineId);
    if (head.files.repositories !== undefined) {
      const repositories = fetched.repositories as { items: unknown[]; truncated: boolean };
      expect(repositories.items.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("answers 304 to If-None-Match with the current ETag, and 200 to any other", async () => {
    const machine = await enrol();
    const { reply } = await readHead(machine);
    const etag = reply.headers.get("etag") ?? "";
    expect(etag).toMatch(/^"sha256:[0-9a-f]{64}"$/);
    const same = await callBytes(machine, "/relay/v1/snapshot/head", { "If-None-Match": etag });
    expect(same.status).toBe(304);
    expect(same.bytes.length).toBe(0);
    expect(same.headers.get("etag")).toBe(etag);
    expect(same.headers.get("cache-control")).toBe("private, no-cache");
    const listed = await callBytes(machine, "/relay/v1/snapshot/head", {
      "If-None-Match": `"sha256:${"0".repeat(64)}", ${etag}`,
    });
    expect(listed.status).toBe(304);
    const other = await callBytes(machine, "/relay/v1/snapshot/head", {
      "If-None-Match": `"sha256:${"0".repeat(64)}"`,
    });
    expect(other.status).toBe(200);
    expect(sha256(other.bytes)).toBe(etag.slice('"sha256:'.length, -1));
  });

  it("refuses an unauthenticated read of the head and of a file", async () => {
    const machine = await enrol();
    const head = await client.send(machine.key, "GET", "/relay/v1/snapshot/head", {
      device: machine.machineId,
      counter: client.nextCounter(),
    });
    expectError(head, 401, "unauthenticated");
    const file = await client.send(
      machine.key,
      "GET",
      `/relay/v1/snapshot/files/${"0".repeat(64)}`,
      {
        device: machine.machineId,
        counter: client.nextCounter(),
      },
    );
    expectError(file, 401, "unauthenticated");
  });

  it("answers 404 to another caller's hash, even when the bytes would be identical", async () => {
    const owner = await enrol();
    const other = await enrol();
    const stranger = await enrol();
    await client.control("/needs", { machineId: owner.machineId, count: 1 });
    await client.rebuildSnapshot(owner.login);
    const { head } = await readHead(owner);
    const ownersNeeds = bare(head.files.needs ?? "");
    const ownersWork = bare(head.files.work ?? "");
    expect((await readFile(owner, ownersNeeds)).status).toBe(200);
    // `other` has a head of its own, which does not name the owner's needs file.
    await readHead(other);
    expectNotFound(await readFile(other, ownersNeeds));
    // `stranger` never read a head. The owner's work file may hold the very bytes `stranger` would get, and
    // it is still refused: sharing storage never grants access.
    expectNotFound(await readFile(stranger, ownersNeeds));
    expectNotFound(await readFile(stranger, ownersWork));
  });

  it.each([
    ["an unknown hash", "0".repeat(64)],
    ["an uppercase hash", "ABCDEF0123456789".repeat(4)],
    ["a 63 character hash", "a".repeat(63)],
    ["a 65 character hash", "a".repeat(65)],
    ["a hash that is not hex", "z".repeat(64)],
    ["a hash with the sha256: prefix", `sha256:${"a".repeat(64)}`],
    ["a short word", "head"],
  ])("answers 404 not_found, never 400, to %s", async (_label, hash) => {
    const machine = await enrol();
    await readHead(machine);
    expectNotFound(await readFile(machine, hash));
  });

  it("answers 404 to the uppercase form of a real hash", async () => {
    const machine = await enrol();
    const { head } = await readHead(machine);
    const hash = bare(head.files.needs ?? "");
    expect((await readFile(machine, hash)).status).toBe(200);
    expectNotFound(await readFile(machine, hash.toUpperCase()));
  });

  // Retention is the last 16 heads, or any head replaced less than 10 minutes ago. A person with 16 heads or
  // fewer therefore never loses a file, so crossing the bound takes 19 heads (the first read and 18 changes).
  it("keeps older heads' files for 10 minutes after replacement, then only the last 16 heads", async () => {
    const machine = await enrol();
    const refs = [(await readHead(machine)).head.files.needs ?? ""];
    for (let index = 0; index < 18; index += 1) {
      refs.push(await needsRefAfterSeed(machine, refs.at(-1) ?? ""));
    }
    expect(new Set(refs).size).toBe(refs.length);
    // Just replaced: every file is still readable, including those of heads beyond the last 16.
    for (const ref of refs) expect((await readFile(machine, bare(ref))).status, ref).toBe(200);
    await client.control("/snapshot/age", { login: machine.login, minutes: 9 });
    for (const ref of refs) expect((await readFile(machine, bare(ref))).status, ref).toBe(200);
    await client.control("/snapshot/age", { login: machine.login, minutes: 2 });
    // 19 heads with a different needs file each: the last 16 are refs 3 to 18, and the current head never expires.
    for (const ref of refs.slice(0, 3)) expectNotFound(await readFile(machine, bare(ref)));
    for (const ref of refs.slice(3)) {
      expect((await readFile(machine, bare(ref))).status, ref).toBe(200);
    }
  });

  it("carries the head's ETag in the facts response as snapshotEtag", async () => {
    const machine = await enrol();
    await readHead(machine);
    await expect
      .poll(async () => {
        const facts = await call(machine, "POST", "/relay/v1/facts", factsFor(machine));
        expect(facts.status, JSON.stringify(facts.body)).toBe(200);
        expectSchema("FactsResponse", facts.body);
        const etag = (facts.body as { snapshotEtag?: string }).snapshotEtag;
        const head = await callBytes(machine, "/relay/v1/snapshot/head");
        return etag !== undefined && head.headers.get("etag") === `"${etag}"`;
      }, POLL)
      .toBe(true);
  });
});

describe("board and leases", () => {
  interface Card {
    readonly task: { readonly id: string };
    readonly column: string;
    readonly status: string;
    readonly lease?: {
      readonly holder: { readonly login: string };
      readonly state: string;
      readonly lastSignalAt: string;
    };
    readonly assignees: ReadonlyArray<{ readonly id: string; readonly login: string }>;
  }
  interface Board {
    readonly columns: ReadonlyArray<{ readonly id: string; readonly title: string }>;
    readonly cards: ReadonlyArray<Card>;
  }
  const POLL = { timeout: 20_000, interval: 100 };
  const readBoard = async (machine: Enrolled): Promise<Board | undefined> => {
    const head = await call(machine, "GET", "/relay/v1/snapshot/head");
    expect(head.status, JSON.stringify(head.body)).toBe(200);
    const ref = await firstBoardRef(
      machine,
      (head.body as { files: Record<string, string> }).files,
    );
    if (ref === undefined) return undefined;
    const file = await call(machine, "GET", `/relay/v1/snapshot/files/${ref.slice(7)}`);
    expect(file.status, JSON.stringify(file.body)).toBe(200);
    expectSchema("SnapshotBoard", file.body);
    return file.body as Board;
  };
  const cardFor = async (machine: Enrolled, taskId: string) => {
    await client.rebuildSnapshot(machine.login);
    const board = await readBoard(machine);
    return board?.cards.find((card) => card.task.id === taskId);
  };
  const seed = async (tasks: ReadonlyArray<Record<string, unknown>>) => {
    await client.control("/board/seed", { tasks });
  };
  const id = () => `t_${randomText(5)}`;

  it("advertises the board section beside the snapshot and the base sections", async () => {
    const machine = await enrol();
    const reply = await call(machine, "GET", "/relay/v1/capabilities");
    expectSchema("Capabilities", reply.body);
    const body = reply.body as {
      snapshot?: { version: number; head: string };
      sections: Array<{ kind: string; flags: string[] }>;
      me: { login: string };
    };
    const board = body.sections.find((section) => section.kind === "board") as
      | { kind: string; version: number; flags: string[] }
      | undefined;
    expect(board?.flags).toContain("leases");
    expect(board?.flags).toContain("boards");
    expect(board?.version).toBe(2);
    expect(body.snapshot?.head).toBe("/relay/v1/snapshot/head");
    expect(body.me.login).toBe(machine.login);
    for (const kind of ["today", "needs", "machines"]) {
      expect(body.sections.some((section) => section.kind === kind)).toBe(true);
    }
    const head = await call(machine, "GET", "/relay/v1/snapshot/head");
    const files = (head.body as { files: Record<string, string> }).files;
    for (const key of ["needs", "work", "machines"]) expect(files[key]).toBeDefined();
  });

  it("puts a seeded board in the head, with the five columns, and validates it", async () => {
    const machine = await enrol();
    const free = id();
    const taken = id();
    await seed([
      { id: free, title: "Free task" },
      { id: taken, title: "Taken task", column: "taken", holder: "bo-example", restsOn: [free] },
    ]);
    const board = await readBoardAfterRebuild(machine);
    expect(board.columns.map((column) => column.id)).toEqual([
      "free",
      "taken",
      "validating",
      "stuck",
      "shipped",
    ]);
    const freeCard = board.cards.find((card) => card.task.id === free);
    expect(freeCard?.column).toBe("free");
    expect(freeCard?.lease).toBeUndefined();
    // README, "Free and Taken": no Free card has a lease or an assignee.
    for (const card of board.cards.filter((each) => each.column === "free")) {
      expect(card.lease).toBeUndefined();
      expect(card.assignees).toEqual([]);
    }
    const takenCard = board.cards.find((card) => card.task.id === taken);
    expect(takenCard?.column).toBe("taken");
    expect(takenCard?.lease?.state).toBe("active");
    expect(takenCard?.lease?.holder.login).toBe("bo-example");
  });

  it("publishes each board in its own file, with an index whose counts match its cards", async () => {
    const machine = await enrol();
    const [a, b, c] = [id(), id(), id()];
    await client.control("/board/seed", {
      boards: [
        { id: "platform", title: "Platform" },
        { id: "ops", title: "Ops" },
      ],
      tasks: [
        { id: a, title: "Platform task" },
        { id: b, title: "Ops task", board: "ops" },
        { id: c, title: "Ops taken", board: "ops", column: "taken", holder: "bo-example" },
      ],
    });
    await client.rebuildSnapshot(machine.login);
    const head = await call(machine, "GET", "/relay/v1/snapshot/head");
    const files = (head.body as { files: Record<string, string> }).files;
    expect(files.board).toBeUndefined();
    const index = await readBoardsIndex(machine, files);
    expect(index?.boards.map((board) => [board.id, board.title])).toEqual([
      ["platform", "Platform"],
      ["ops", "Ops"],
    ]);
    const boardKeys = Object.keys(files).filter((key) => key.startsWith("board."));
    expect(boardKeys.toSorted()).toEqual(["board.ops", "board.platform"]);
    const seen = new Map<string, string>();
    for (const entry of index?.boards ?? []) {
      expect(entry.mode).toBe("dev");
      const file = await call(
        machine,
        "GET",
        `/relay/v1/snapshot/files/${(files[`board.${entry.id}`] ?? "").slice(7)}`,
      );
      expectSchema("SnapshotBoard", file.body);
      const cards = (file.body as Board).cards;
      const tally: Record<string, number> = {};
      for (const card of cards) {
        tally[card.column] = (tally[card.column] ?? 0) + 1;
        // README, "Several boards": a task id is relay-wide; this seed puts each task on one board.
        expect(seen.has(card.task.id), `${card.task.id} on two boards`).toBe(false);
        seen.set(card.task.id, entry.id);
      }
      const counted = Object.fromEntries(Object.entries(entry.counts).filter(([, n]) => n > 0));
      expect(counted).toEqual(tally);
    }
    expect(seen.get(a)).toBe("platform");
    expect(seen.get(b)).toBe("ops");
    expect(seen.get(c)).toBe("ops");
  });

  it("lists every linked pull request in prs, with per-PR checks, and no card-level pr or checks", async () => {
    const machine = await enrol();
    const many = id();
    const none = id();
    await seed([
      {
        id: many,
        title: "Two pull requests",
        prs: [
          { number: 7, state: "closed" },
          { number: 9, state: "open", checks: "failing" },
        ],
      },
      { id: none, title: "No pull request" },
    ]);
    await client.rebuildSnapshot(machine.login);
    const head = await call(machine, "GET", "/relay/v1/snapshot/head");
    const ref =
      (await firstBoardRef(machine, (head.body as { files: Record<string, string> }).files)) ?? "";
    const file = await call(machine, "GET", `/relay/v1/snapshot/files/${ref.slice(7)}`);
    expectSchema("SnapshotBoard", file.body);
    const cards = (
      file.body as { cards: Array<Record<string, unknown> & { task: { id: string } }> }
    ).cards;
    const card = cards.find((candidate) => candidate.task.id === many);
    expect(card).not.toHaveProperty("pr");
    expect(card).not.toHaveProperty("checks");
    expect(card?.prs).toMatchObject([
      { number: 7, url: expect.stringContaining("/7"), state: "closed" },
      {
        number: 9,
        url: expect.stringContaining("/9"),
        state: "open",
        checks: { state: "failing" },
      },
    ]);
    expect(cards.find((candidate) => candidate.task.id === none)?.prs).toEqual([]);
    const read = await call(machine, "GET", `/relay/v1/tasks/${many}`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expectSchema("TaskRead", read.body);
    expect(read.body).not.toHaveProperty("pr");
    expect(read.body).not.toHaveProperty("checks");
    expect((read.body as { prs: unknown[] }).prs).toHaveLength(2);
  });

  it("dates every task: openedAt always, closedAt null while open", async () => {
    const machine = await enrol();
    const open = id();
    const closed = id();
    await seed([
      { id: open, title: "Open task", openedAt: "2026-11-20T09:00:00Z" },
      {
        id: closed,
        title: "Closed task",
        status: "built",
        openedAt: "2026-11-21T09:00:00Z",
        closedAt: "2026-11-22T09:00:00Z",
      },
    ]);
    const board = await readBoardAfterRebuild(machine);
    const taskOf = (taskId: string) =>
      (board.cards.find((card) => card.task.id === taskId)?.task ?? {}) as {
        openedAt?: string;
        closedAt?: string | null;
      };
    expect(Date.parse(taskOf(open).openedAt ?? "")).toBe(Date.parse("2026-11-20T09:00:00Z"));
    expect(taskOf(open).closedAt).toBeNull();
    expect(Date.parse(taskOf(closed).openedAt ?? "")).toBe(Date.parse("2026-11-21T09:00:00Z"));
    expect(Date.parse(taskOf(closed).closedAt ?? "")).toBe(Date.parse("2026-11-22T09:00:00Z"));
    const read = await call(machine, "GET", `/relay/v1/tasks/${closed}`);
    expectSchema("TaskRead", read.body);
    expect(Date.parse((read.body as { task: { closedAt: string } }).task.closedAt)).toBe(
      Date.parse("2026-11-22T09:00:00Z"),
    );
  });

  it("gives each shipped item its own pr and the task's ref, so no board join is needed", async () => {
    const shippedTask = id();
    const openTask = id();
    await seed([
      {
        id: shippedTask,
        title: "Shipped task",
        status: "built",
        prs: [{ number: 41, state: "merged", checks: "passing" }],
      },
      { id: openTask, title: "Still open", prs: [{ number: 42, state: "open" }] },
    ]);
    const machine = await enrol();
    const reply = await call(machine, "GET", "/relay/v1/today");
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expectSchema("Today", reply.body);
    const shipped = (
      reply.body as {
        shipped: {
          state: string;
          items: Array<{
            task: { id: string };
            pr: { number: number; url: string; repo: string };
            ref?: { tracker: string; scope: string; key: string; url: string };
          }>;
        };
      }
    ).shipped;
    const filtered = await call(machine, "GET", "/relay/v1/today?since=2099-01-01T00%3A00%3A00Z");
    expect(filtered.body).toMatchObject({ shipped: { items: [] } });
    expect(reply.body).not.toHaveProperty("lastVisitAt");
    const unfiltered = await call(machine, "GET", "/relay/v1/today");
    expect(unfiltered.body).toMatchObject({ shipped });
    expect(shipped.state).toBe("ok");
    const item = shipped.items.find((candidate) => candidate.task.id === shippedTask);
    expect(item?.pr.number).toBe(41);
    expect(item?.pr.url).toContain("/41");
    expect(item?.pr.repo).toMatch(/^[^/\s]+\/[^/\s]+$/);
    expect(item?.ref?.tracker).toBeTruthy();
    expect(item?.ref?.url).toBeTruthy();
    expect(shipped.items.some((candidate) => candidate.task.id === openTask)).toBe(false);
  });

  const readBoardAfterRebuild = async (machine: Enrolled) => {
    await client.rebuildSnapshot(machine.login);
    const board = await readBoard(machine);
    expect(board).toBeDefined();
    return board as Board;
  };

  it("ages a lease to stale at 7 h and expired at 25 h, in Stuck and never Free", async () => {
    const machine = await enrol();
    const task = id();
    await seed([{ id: task, title: "Held task", column: "taken", holder: "bo-example" }]);
    await client.control("/lease/age", { taskId: task, hours: 7 });
    await expect.poll(async () => (await cardFor(machine, task))?.lease?.state, POLL).toBe("stale");
    expect((await cardFor(machine, task))?.column).toBe("stuck");
    await client.control("/lease/age", { taskId: task, hours: 18 });
    await expect
      .poll(async () => (await cardFor(machine, task))?.lease?.state, POLL)
      .toBe("expired");
    const expired = await cardFor(machine, task);
    expect(expired?.column).toBe("stuck");
    expect(expired?.column).not.toBe("free");
    expect(expired?.lease?.holder.login).toBe("bo-example");
  });

  it("returns the lease to active when a fact carries the taskId", async () => {
    const machine = await enrol();
    const task = id();
    await seed([{ id: task, title: "Held task", column: "taken", holder: machine.login }]);
    await client.control("/lease/age", { taskId: task, hours: 25 });
    await expect
      .poll(async () => (await cardFor(machine, task))?.lease?.state, POLL)
      .toBe("expired");
    const body = factsFor(machine) as unknown as { activity: Array<Record<string, unknown>> };
    const first = body.activity[0];
    if (first === undefined) throw new Error("facts example has no activity");
    first.taskId = task;
    const sent = await call(machine, "POST", "/relay/v1/facts", body);
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    await expect
      .poll(async () => (await cardFor(machine, task))?.lease?.state, POLL)
      .toBe("active");
    expect((await cardFor(machine, task))?.column).toBe("taken");
  });

  it("refreshes a lease from a fact that matches the task's branch and projectKey", async () => {
    const machine = await enrol();
    const task = id();
    const body = factsFor(machine) as unknown as {
      activity: Array<{ branch?: string; projectKey: string; taskId?: string }>;
    };
    const first = body.activity[0];
    if (first === undefined) throw new Error("facts example has no activity");
    delete first.taskId;
    await seed([
      {
        id: task,
        title: "Held task",
        column: "taken",
        holder: machine.login,
        branch: first.branch,
        projectKey: first.projectKey,
      },
    ]);
    await client.control("/lease/age", { taskId: task, hours: 8 });
    await expect.poll(async () => (await cardFor(machine, task))?.lease?.state, POLL).toBe("stale");
    const sent = await call(machine, "POST", "/relay/v1/facts", body);
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    await expect
      .poll(async () => (await cardFor(machine, task))?.lease?.state, POLL)
      .toBe("active");
  });

  it("ignores a fact from a machine whose owner is not the lease holder", async () => {
    const holder = await enrol();
    const coworker = await enrol();
    const task = id();
    await seed([{ id: task, title: "Held task", column: "taken", holder: holder.login }]);
    await client.control("/lease/age", { taskId: task, hours: 8 });
    await expect
      .poll(async () => (await cardFor(coworker, task))?.lease?.state, POLL)
      .toBe("stale");
    const before = (await cardFor(coworker, task))?.lease;
    const body = factsFor(coworker) as unknown as { activity: Array<Record<string, unknown>> };
    const first = body.activity[0];
    if (first === undefined) throw new Error("facts example has no activity");
    first.taskId = task;
    const sent = await call(coworker, "POST", "/relay/v1/facts", body);
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    await client.rebuildSnapshot(coworker.login);
    const after = await cardFor(coworker, task);
    expect(after?.lease?.state).toBe("stale");
    expect(after?.lease?.lastSignalAt).toBe(before?.lastSignalAt);
  });

  it("ignores a fact from a stopped session", async () => {
    const machine = await enrol();
    const task = id();
    await seed([{ id: task, title: "Held task", column: "taken", holder: machine.login }]);
    await client.control("/lease/age", { taskId: task, hours: 8 });
    await expect.poll(async () => (await cardFor(machine, task))?.lease?.state, POLL).toBe("stale");
    const before = (await cardFor(machine, task))?.lease;
    const body = factsFor(machine) as unknown as { activity: Array<Record<string, unknown>> };
    const first = body.activity[0];
    if (first === undefined) throw new Error("facts example has no activity");
    first.taskId = task;
    first.state = "stopped";
    first.stopReason = "killed";
    first.processRunning = false;
    delete first.waiting;
    const sent = await call(machine, "POST", "/relay/v1/facts", body);
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    await client.rebuildSnapshot(machine.login);
    const after = await cardFor(machine, task);
    expect(after?.lease?.state).toBe("stale");
    expect(after?.lease?.lastSignalAt).toBe(before?.lastSignalAt);
  });
});

describe("feed, graveyard, tasks and checked", () => {
  interface FeedFile {
    readonly entries: ReadonlyArray<{ readonly id: string; readonly summary: string }>;
    readonly nextCursor: string | null;
  }
  interface GraveyardFile {
    readonly entries: ReadonlyArray<{
      readonly task: { readonly id: string };
      readonly cause: string;
    }>;
    readonly nextCursor: string | null;
  }
  interface TaskReply {
    readonly status: string;
    readonly preview?: { readonly state: string; readonly url?: string };
    readonly checked?: {
      readonly by: { readonly id: string; readonly login: string };
      readonly valid: boolean;
      readonly ignoredReason?: string;
    };
    readonly task: { readonly id: string };
  }
  const id = () => `t_${randomText(5)}`;

  const readHeadFile = async (machine: Enrolled, kind: "feed" | "graveyard", schema: string) => {
    await client.rebuildSnapshot(machine.login);
    const head = await call(machine, "GET", "/relay/v1/snapshot/head");
    expect(head.status, JSON.stringify(head.body)).toBe(200);
    const ref = (head.body as { files: Record<string, string> }).files[kind];
    expect(ref, `the head names ${kind}`).toBeDefined();
    const file = await call(machine, "GET", `/relay/v1/snapshot/files/${(ref ?? "").slice(7)}`);
    expect(file.status, JSON.stringify(file.body)).toBe(200);
    expectSchema(schema, file.body);
    return file.body;
  };
  const readTask = async (machine: Enrolled, taskId: string) => {
    const reply = await call(machine, "GET", `/relay/v1/tasks/${taskId}`);
    return reply;
  };
  const seedTasks = (tasks: ReadonlyArray<Record<string, unknown>>) =>
    client.control("/board/seed", { tasks });

  it("advertises the feed and task sections and the checked flag", async () => {
    const machine = await enrol();
    const reply = await call(machine, "GET", "/relay/v1/capabilities");
    expectSchema("Capabilities", reply.body);
    const sections = (reply.body as { sections: Array<{ kind: string; flags: string[] }> })
      .sections;
    expect(sections.find((section) => section.kind === "feed")?.flags).toContain("graveyard");
    expect(sections.some((section) => section.kind === "task")).toBe(true);
    expect(sections.find((section) => section.kind === "board")?.flags).toContain("checked");
  });

  it("puts the feed in the head, newest first, and validates it", async () => {
    const machine = await enrol();
    await client.control("/feed/seed", { count: 3 });
    const feed = (await readHeadFile(machine, "feed", "FeedPage")) as FeedFile;
    expect(feed.entries).toHaveLength(3);
    expect(feed.nextCursor).toBeNull();
    const times = feed.entries.map((entry) => (entry as unknown as { at: string }).at);
    expect(times).toEqual(times.toSorted().toReversed());
  });

  it("holds the latest 100 feed entries in the head and pages the rest", async () => {
    const machine = await enrol();
    await client.control("/feed/seed", { count: 120 });
    const feed = (await readHeadFile(machine, "feed", "FeedPage")) as FeedFile;
    expect(feed.entries).toHaveLength(100);
    expect(feed.nextCursor).not.toBeNull();
    const next = await call(
      machine,
      "GET",
      `/relay/v1/feed?cursor=${encodeURIComponent(feed.nextCursor ?? "")}`,
    );
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    expectSchema("FeedPage", next.body);
    const second = next.body as FeedFile;
    expect(second.entries).toHaveLength(20);
    expect(second.nextCursor).toBeNull();
    const seen = new Set([...feed.entries, ...second.entries].map((entry) => entry.id));
    expect(seen.size).toBe(120);
    const small = await call(machine, "GET", "/relay/v1/feed?limit=7");
    expectSchema("FeedPage", small.body);
    expect((small.body as FeedFile).entries).toHaveLength(7);
    expect((small.body as FeedFile).nextCursor).not.toBeNull();
    const bad = await call(machine, "GET", "/relay/v1/feed?cursor=nonsense");
    expectError(bad, 400, "malformed");
    const unsigned = await client.send(machine.key, "GET", "/relay/v1/feed", { unsigned: true });
    expect(unsigned.status).toBe(401);
  });

  it("shows the cause of a graveyard entry, in the head and in the paging call", async () => {
    const machine = await enrol();
    const cause = `superseded by #${randomText(2)}`;
    await client.control("/graveyard/seed", { cause, count: 120 });
    const graveyard = (await readHeadFile(machine, "graveyard", "GraveyardPage")) as GraveyardFile;
    expect(graveyard.entries).toHaveLength(100);
    expect(graveyard.entries.every((entry) => entry.cause === cause)).toBe(true);
    expect(graveyard.nextCursor).not.toBeNull();
    const next = await call(
      machine,
      "GET",
      `/relay/v1/graveyard?cursor=${encodeURIComponent(graveyard.nextCursor ?? "")}`,
    );
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    expectSchema("GraveyardPage", next.body);
    const second = next.body as GraveyardFile;
    expect(second.entries).toHaveLength(20);
    expect(second.entries[0]?.cause).toBe(cause);
    expect(second.nextCursor).toBeNull();
  });

  it("reads one task with the board card fields, and answers 404 for an unknown or malformed id", async () => {
    const machine = await enrol();
    const known = id();
    await seedTasks([
      {
        id: known,
        title: "Known task",
        preview: { state: "ready", url: "https://preview.example.com/known" },
      },
    ]);
    const reply = await readTask(machine, known);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expectSchema("TaskRead", reply.body);
    const task = reply.body as TaskReply;
    expect(task.task.id).toBe(known);
    expect(task.status).toBe("planned");
    expect(task.preview?.state).toBe("ready");
    expect(task.checked).toBeUndefined();
    expectError(await readTask(machine, id()), 404, "not_found");
    expectError(await readTask(machine, "not%20an%20id"), 404, "not_found");
    expectError(await readTask(machine, "x".repeat(65)), 404, "not_found");
    const unsigned = await client.send(machine.key, "GET", `/relay/v1/tasks/${known}`, {
      unsigned: true,
    });
    expect(unsigned.status).toBe(401);
  });

  it("directs approval-only PRs to the reviewer and author separately", async () => {
    const reviewer = await enrol();
    const author = await enrol();
    const task = id();
    const pr = {
      number: 123,
      author: author.login,
      canApprove: [author.login, reviewer.login, "unknown"],
      approvals: {
        required: 1,
        have: 0,
        codeOwners: { required: true, owners: ["org/team"] },
        lastPushApproval: false,
        lastPushSatisfied: true,
        stale: true,
      },
      approvalOnly: true,
    };
    const seed = (approvalOnly: boolean) =>
      seedTasks([{ id: task, prs: [{ ...pr, approvalOnly }] }]);
    const events = await openEvents(reviewer);
    await seed(true);
    expect(await nextEvent(events)).toMatchObject({ event: "needs.changed", data: { count: 1 } });
    const reply = await readTask(reviewer, task);
    expectSchema("TaskRead", reply.body);
    expect(reply.body).toMatchObject({
      prs: [
        { approvals: pr.approvals, youCanApprove: true, canApprove: [{ login: reviewer.login }] },
      ],
    });
    expect((await readTask(author, task)).body).toMatchObject({ prs: [{ youCanApprove: false }] });
    const kinds = async (who: Enrolled) =>
      ((await call(who, "GET", "/relay/v1/needs")).body as { items: { kind: string }[] }).items.map(
        (item) => item.kind,
      );
    expect(await kinds(reviewer)).toContain("pr_approval");
    expect(await kinds(author)).toContain("waiting_for_approver");
    await seed(false);
    expect(await nextEvent(events)).toMatchObject({ event: "needs.changed", data: { count: 0 } });
    await events.cancel();
    expect(await kinds(reviewer)).not.toContain("pr_approval");
    expect(await kinds(author)).not.toContain("waiting_for_approver");
  });

  describe("checked", () => {
    const personIdOf = async (machine: Enrolled): Promise<string> => {
      const reply = await call(machine, "GET", "/relay/v1/capabilities");
      return (reply.body as { me: { id: string } }).me.id;
    };
    const checkedFor = async (by: Enrolled) => {
      const machine = await enrol();
      const task = id();
      await seedTasks([{ id: task, title: "Built task" }]);
      await client.control("/checked/seed", {
        taskId: task,
        by: await personIdOf(by),
      });
      const reply = await readTask(machine, task);
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      expectSchema("TaskRead", reply.body);
      await client.rebuildSnapshot(machine.login);
      const head = await call(machine, "GET", "/relay/v1/snapshot/head");
      const ref =
        (await firstBoardRef(machine, (head.body as { files: Record<string, string> }).files)) ??
        "";
      const board = await call(machine, "GET", `/relay/v1/snapshot/files/${ref.slice(7)}`);
      expectSchema("SnapshotBoard", board.body);
      const card = (
        board.body as { cards: Array<{ task: { id: string }; status: string }> }
      ).cards.find((candidate) => candidate.task.id === task);
      return { task: reply.body as TaskReply, boardStatus: card?.status };
    };

    it("is valid when a sign-off role holder adds the company label", async () => {
      const checker = await enrol({ role: "founder" });
      const { task, boardStatus } = await checkedFor(checker);
      expect(task.checked?.valid).toBe(true);
      expect(task.checked?.by.login).toBe(checker.login);
      expect(task.checked?.by.id).toBe(await personIdOf(checker));
      expect(task.checked?.ignoredReason).toBeUndefined();
      expect(task.status).toBe("checked");
      expect(boardStatus).toBe("checked");
    });

    it("is invalid, with the reason, when the checker lacks the sign-off role", async () => {
      const checker = await enrol({ role: "staff" });
      const { task, boardStatus } = await checkedFor(checker);
      expect(task.checked?.valid).toBe(false);
      expect(task.checked?.ignoredReason).toMatch(/sign-off role/);
      expect(task.status).not.toBe("checked");
      expect(boardStatus).not.toBe("checked");
    });
  });
});

describe("lease protocol", () => {
  interface LastRelease {
    readonly by: { readonly login: string };
    readonly reason: string;
    readonly freeToContinue: boolean;
    readonly reasonText?: string;
    readonly note?: string;
  }
  interface Card {
    readonly task: { readonly id: string };
    readonly column: string;
    readonly status: string;
    readonly lease?: { readonly holder: { readonly login: string }; readonly state: string };
    readonly lastRelease?: LastRelease;
    readonly assignees: ReadonlyArray<{ readonly id: string; readonly login: string }>;
  }
  interface FeedEntry {
    readonly type: string;
    readonly task?: { readonly id: string };
    readonly author?: { readonly login: string };
    readonly reason?: string;
    readonly freeToContinue?: boolean;
    readonly note?: string;
  }
  const id = () => `t_${randomText(5)}`;
  const headFile = async (machine: Enrolled, kind: "board" | "feed", schema: string) => {
    await client.rebuildSnapshot(machine.login);
    const head = await call(machine, "GET", "/relay/v1/snapshot/head");
    expect(head.status, JSON.stringify(head.body)).toBe(200);
    const files = (head.body as { files: Record<string, string> }).files;
    const ref = (kind === "board" ? await firstBoardRef(machine, files) : files[kind]) ?? "";
    const file = await call(machine, "GET", `/relay/v1/snapshot/files/${ref.slice(7)}`);
    expect(file.status, JSON.stringify(file.body)).toBe(200);
    expectSchema(schema, file.body);
    return file.body;
  };
  const cardFor = async (machine: Enrolled, taskId: string) =>
    ((await headFile(machine, "board", "SnapshotBoard")) as { cards: Card[] }).cards.find(
      (card) => card.task.id === taskId,
    );
  const releasesOf = async (machine: Enrolled, taskId: string) =>
    ((await headFile(machine, "feed", "FeedPage")) as { entries: FeedEntry[] }).entries.filter(
      (entry) => entry.type === "released" && entry.task?.id === taskId,
    );

  it("holds a task from its claim comment, assignee and claimed label", async () => {
    const machine = await enrol();
    const holder = newLogin();
    const task = id();
    await client.control("/board/seed", {
      tasks: [
        {
          id: task,
          title: "Claimed task",
          comments: [{ author: holder, body: `claim: ${holder}/hub` }],
          assignees: [holder],
          labels: ["claimed"],
        },
      ],
    });
    const card = await cardFor(machine, task);
    expect(card?.lease?.holder.login).toBe(holder);
    expect(card?.lease?.state).toBe("active");
    expect(card?.column).toBe("taken");
    expect(card?.lastRelease).toBeUndefined();
  });

  it("frees a released task with lastRelease and one released feed entry", async () => {
    const machine = await enrol();
    const holder = newLogin();
    const task = id();
    await client.control("/board/seed", {
      tasks: [
        {
          id: task,
          title: "Handed over task",
          comments: [{ author: holder, body: `claim: ${holder}/hub` }],
          assignees: [holder],
          labels: ["claimed"],
        },
      ],
    });
    await client.control("/board/tracker", {
      taskId: task,
      comments: [
        {
          author: holder,
          body: "release: out_of_usage · free to continue\n**Next:** wire the button.",
        },
      ],
      assignees: [],
      labels: [],
    });
    const card = await cardFor(machine, task);
    expect(card?.lease).toBeUndefined();
    expect(card?.column).toBe("free");
    expect(card?.lastRelease).toMatchObject({
      by: { login: holder },
      reason: "out_of_usage",
      freeToContinue: true,
      note: "**Next:** wire the button.",
    });
    const read = await call(machine, "GET", `/relay/v1/tasks/${task}`);
    expectSchema("TaskRead", read.body);
    expect((read.body as { lastRelease?: LastRelease }).lastRelease?.note).toBe(
      "**Next:** wire the button.",
    );
    const entries = await releasesOf(machine, task);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      author: { login: holder },
      reason: "out_of_usage",
      freeToContinue: true,
    });
  });

  it("gives a same-second race to the lower comment id and marks the conflict", async () => {
    const machine = await enrol();
    const first = newLogin();
    const second = newLogin();
    const task = id();
    await client.control("/board/seed", {
      tasks: [
        {
          id: task,
          title: "Raced task",
          comments: [
            // Seeded in one call, both get the same time.
            { id: "1002", author: first, body: `claim: ${first}/hub` },
            { id: "998", author: second, body: `claim: ${second}/hub` },
          ],
          assignees: [first, second],
          labels: ["claimed"],
        },
      ],
    });
    const card = await cardFor(machine, task);
    expect(card?.lease).toMatchObject({ holder: { login: second }, state: "conflict" });
    expect(card?.status).toBe("needs_you");
    await client.control("/board/tracker", {
      taskId: task,
      comments: [{ author: first, body: `release: lost_claim · @${second}` }],
      assignees: [second],
    });
    const after = await cardFor(machine, task);
    expect(after?.lease).toMatchObject({ holder: { login: second }, state: "active" });
    expect(await releasesOf(machine, task)).toHaveLength(0);
  });

  it("marks a take that never landed as incomplete after the settle window", async () => {
    const machine = await enrol();
    const holder = newLogin();
    const stuck = id();
    await client.control("/board/seed", {
      tasks: [
        { id: stuck, title: "Stuck", comments: [{ author: holder, body: `claim: ${holder}/hub` }] },
      ],
    });
    expect((await cardFor(machine, stuck))?.lease?.state).toBe("active");
    // Three minutes on: past the 60 s settle window, still unassigned.
    await client.control("/lease/age", { taskId: stuck, hours: 0.05 });
    const card = await cardFor(machine, stuck);
    expect(card?.lease).toMatchObject({ holder: { login: holder }, state: "incomplete" });
    expect(card?.column).toBe("stuck");
  });

  it("shows a plain assignee as Taken with no lease, and names the assignees", async () => {
    const machine = await enrol();
    const task = id();
    const nobody = id();
    const assignee = newLogin();
    await client.control("/board/seed", {
      tasks: [
        { id: task, title: "Assigned elsewhere", assignees: [assignee] },
        { id: nobody, title: "Nobody assigned", assignees: [] },
      ],
    });
    const card = await cardFor(machine, task);
    expect(card?.lease).toBeUndefined();
    expect(card?.column).toBe("taken");
    expect(card?.assignees.map((person) => person.login)).toEqual([assignee]);
    expect(card?.assignees[0]?.id).toEqual(expect.any(String));
    // README, "Free and Taken": Free = no assignee and no lease.
    const free = await cardFor(machine, nobody);
    expect(free?.column).toBe("free");
    expect(free?.lease).toBeUndefined();
    expect(free?.assignees).toEqual([]);
  });

  it("ignores another person's release and counts a founder's", async () => {
    const machine = await enrol();
    const founder = await enrol({ role: "founder" });
    const holder = newLogin();
    const stranger = newLogin();
    const task = id();
    await client.control("/board/seed", {
      tasks: [
        {
          id: task,
          title: "Founder release",
          comments: [
            { author: holder, body: `claim: ${holder}/hub` },
            { author: stranger, body: "release: done" },
          ],
          assignees: [holder],
          labels: ["claimed"],
        },
      ],
    });
    expect((await cardFor(machine, task))?.lease?.holder.login).toBe(holder);
    await client.control("/board/tracker", {
      taskId: task,
      comments: [{ author: founder.login, body: "release: deprioritised" }],
      assignees: [],
      labels: [],
    });
    const card = await cardFor(machine, task);
    expect(card?.lease).toBeUndefined();
    expect(card?.lastRelease).toMatchObject({
      by: { login: founder.login },
      reason: "deprioritised",
      freeToContinue: false,
    });
  });
});

describe("map and the stage plan", () => {
  interface MapItem {
    readonly id: string;
    readonly stageId: string;
    readonly status: string;
    readonly statusWhy: string;
    readonly task?: {
      readonly id: string;
      readonly title: string;
      readonly ref: { tracker: string; scope: string; key: string; url: string };
      readonly openedAt: string;
      readonly closedAt: string | null;
    };
    readonly restsOn: ReadonlyArray<string>;
    readonly blockedBy: ReadonlyArray<string>;
  }
  interface MapFile {
    readonly state: string;
    readonly notMeasured: ReadonlyArray<{ readonly reason: string; readonly detail?: string }>;
    readonly stages: ReadonlyArray<{ readonly id: string; readonly order: number }>;
    readonly items: ReadonlyArray<MapItem>;
    readonly counters: {
      readonly byStatus: Record<string, number>;
      readonly byStage: Record<string, Record<string, number>>;
    };
  }
  interface BoardFile {
    readonly cards: ReadonlyArray<{
      readonly task: {
        readonly id: string;
        readonly ref: { tracker: string; host?: string; scope: string; key: string };
      };
    }>;
  }
  const id = () => `t_${randomText(5)}`;
  const base = { version: 1, generatedAt: "2026-11-26T09:00:00Z" };

  const headFiles = async (machine: Enrolled) => {
    await client.rebuildSnapshot(machine.login);
    const head = await call(machine, "GET", "/relay/v1/snapshot/head");
    expect(head.status, JSON.stringify(head.body)).toBe(200);
    return (head.body as { files: Record<string, string> }).files;
  };
  const readFile = async (machine: Enrolled, ref: string, schema: string) => {
    const file = await call(machine, "GET", `/relay/v1/snapshot/files/${ref.slice(7)}`);
    expect(file.status, JSON.stringify(file.body)).toBe(200);
    expectSchema(schema, file.body);
    return file.body;
  };
  const readMap = async (machine: Enrolled) => {
    const ref = (await headFiles(machine)).map;
    expect(ref, "the head names map").toBeDefined();
    return (await readFile(machine, ref ?? "", "SnapshotMap")) as MapFile;
  };
  const mapSection = async (machine: Enrolled) => {
    const reply = await call(machine, "GET", "/relay/v1/capabilities");
    expectSchema("Capabilities", reply.body);
    return (reply.body as { sections: Array<{ kind: string; flags: string[] }> }).sections.find(
      (section) => section.kind === "map",
    );
  };
  // Seeds the board, then reads each card's own ref back, so the plan joins on what the relay reports.
  const seedBoard = async (machine: Enrolled, tasks: ReadonlyArray<Record<string, unknown>>) => {
    await client.control("/board/seed", { tasks });
    const files = await headFiles(machine);
    const board = (await readFile(
      machine,
      (await firstBoardRef(machine, files)) ?? "",
      "SnapshotBoard",
    )) as BoardFile;
    return (taskId: string) => {
      const card = board.cards.find((candidate) => candidate.task.id === taskId);
      expect(card, `board holds ${taskId}`).toBeDefined();
      const ref = card?.task.ref ?? { tracker: "", scope: "", key: "" };
      return {
        tracker: ref.tracker,
        ...(ref.host === undefined ? {} : { host: ref.host }),
        scope: ref.scope,
        key: ref.key,
      };
    };
  };

  afterAll(async () => {
    await client.control("/map/seed", { plan: null });
  });

  it("does not advertise the map, or name a file, while no plan is configured", async () => {
    const machine = await enrol();
    await client.control("/map/seed", { plan: null });
    expect(await mapSection(machine)).toBeUndefined();
    expect((await headFiles(machine)).map).toBeUndefined();
  });

  it("builds the map from the plan, in stage order, and validates it", async () => {
    const machine = await enrol();
    const done = id();
    const blocked = id();
    const built = id();
    const taskFor = await seedBoard(machine, [
      { id: done, title: "Done task", status: "checked" },
      { id: blocked, title: "Blocked task", status: "needs_you" },
      { id: built, title: "Built task", status: "built" },
    ]);
    await client.control("/map/seed", {
      ...base,
      stages: [
        { id: "late", title: "Later", order: 20 },
        { id: "early", title: "First", order: 10 },
      ],
      items: [
        { id: "i-late", stageId: "late", title: "Late item", restsOn: ["i-blocked"] },
        { id: "i-done", stageId: "early", title: "Done item", task: taskFor(done) },
        { id: "i-blocked", stageId: "early", title: "Blocked item", task: taskFor(blocked) },
        {
          id: "i-built",
          stageId: "late",
          title: "Built item",
          task: taskFor(built),
          restsOn: ["i-done"],
        },
      ],
    });
    const section = await mapSection(machine);
    expect(section?.flags).toContain("rests_on");
    const map = await readMap(machine);
    expect(map.state).toBe("ok");
    expect(map.notMeasured).toEqual([]);
    expect(map.stages.map((stage) => stage.id)).toEqual(["early", "late"]);
    expect(map.stages.map((stage) => stage.order)).toEqual([10, 20]);
    // Grouped by stage in stage order.
    expect(map.items.map((item) => item.stageId)).toEqual(["early", "early", "late", "late"]);
    const item = (itemId: string) => map.items.find((candidate) => candidate.id === itemId);
    expect(item("i-done")?.status).toBe("checked");
    expect(item("i-done")?.task?.id).toBe(done);
    expect(item("i-blocked")?.status).toBe("needs_you");
    expect(item("i-built")?.status).toBe("built");
    expect(item("i-built")?.restsOn).toEqual(["i-done"]);
  });

  it("makes an item that rests on a blocking one blocked, not needs_you, and names the blocker", async () => {
    const machine = await enrol();
    const blocker = id();
    const dead = id();
    const taskFor = await seedBoard(machine, [
      { id: blocker, title: "Profile blocks", status: "sent_back" },
      { id: dead, title: "Old idea", status: "ruled_dead" },
    ]);
    await client.control("/map/seed", {
      ...base,
      stages: [{ id: "s", title: "Stage", order: 1 }],
      items: [
        { id: "blocker", stageId: "s", title: "Profile blocks", task: taskFor(blocker) },
        { id: "dead", stageId: "s", title: "Old idea", task: taskFor(dead) },
        { id: "child", stageId: "s", title: "Child", restsOn: ["blocker"] },
        { id: "grandchild", stageId: "s", title: "Grandchild", restsOn: ["child"] },
        { id: "orphan", stageId: "s", title: "Orphan", restsOn: ["dead"] },
        { id: "free", stageId: "s", title: "Free" },
      ],
    });
    const map = await readMap(machine);
    const item = (itemId: string) => map.items.find((candidate) => candidate.id === itemId);
    expect(item("blocker")?.status).toBe("sent_back");
    expect(item("blocker")?.blockedBy).toEqual([]);
    expect(item("child")?.status).toBe("blocked");
    expect(item("child")?.blockedBy).toEqual(["blocker"]);
    expect(item("child")?.statusWhy).toContain("Profile blocks");
    // A blocked item blocks its own dependants in turn, and they name it, not the root cause.
    expect(item("grandchild")?.status).toBe("blocked");
    expect(item("grandchild")?.blockedBy).toEqual(["child"]);
    expect(item("grandchild")?.statusWhy).toContain("Child");
    expect(item("orphan")?.status).toBe("blocked");
    expect(item("orphan")?.blockedBy).toEqual(["dead"]);
    expect(item("orphan")?.statusWhy).toContain("Old idea");
    expect(item("free")?.status).toBe("planned");
    expect(item("free")?.blockedBy).toEqual([]);
    expect(item("free")?.task).toBeUndefined();
    expect(map.items.some((candidate) => candidate.status === "needs_you")).toBe(false);
  });

  it("lists only direct blockers in blockedBy, in restsOn order, across a seeded chain", async () => {
    const machine = await enrol();
    await client.control("/map/seed", {
      plan: {
        ...base,
        stages: [{ id: "s", title: "Stage", order: 1 }],
        items: [
          { id: "root", stageId: "s", title: "Root" },
          { id: "dead", stageId: "s", title: "Dead" },
          { id: "fine", stageId: "s", title: "Fine" },
          { id: "mid", stageId: "s", title: "Mid", restsOn: ["fine", "root"] },
          { id: "leaf", stageId: "s", title: "Leaf", restsOn: ["dead", "fine", "mid"] },
          { id: "done", stageId: "s", title: "Done", restsOn: ["mid"] },
          { id: "seeded", stageId: "s", title: "Seeded blocked" },
        ],
      },
      statuses: {
        root: "needs_you",
        dead: "ruled_dead",
        fine: "built",
        done: "checked",
        seeded: "blocked",
      },
    });
    const map = await readMap(machine);
    const item = (itemId: string) => map.items.find((candidate) => candidate.id === itemId);
    expect(item("root")?.status).toBe("needs_you");
    expect(item("mid")?.status).toBe("blocked");
    expect(item("mid")?.blockedBy).toEqual(["root"]);
    expect(item("mid")?.statusWhy).toContain("Root");
    expect(item("leaf")?.status).toBe("blocked");
    // Its direct blockers in restsOn order; never the root cause behind "mid".
    expect(item("leaf")?.blockedBy).toEqual(["dead", "mid"]);
    expect(item("leaf")?.statusWhy).toContain("Dead");
    // A higher own status is kept, and its blockers are still listed.
    expect(item("done")?.status).toBe("checked");
    expect(item("done")?.blockedBy).toEqual(["mid"]);
    // `blocked` never appears without a blocker.
    expect(item("seeded")?.status).toBe("planned");
    for (const entry of map.items) {
      if (entry.status === "blocked") expect(entry.blockedBy.length).toBeGreaterThan(0);
    }
    expect(map.counters.byStatus.blocked).toBe(2);
  });

  it("starts a card that is blocked on the board from its unblocked status on the map", async () => {
    const machine = await enrol();
    const waiting = id();
    const merged = id();
    const taskFor = await seedBoard(machine, [
      { id: waiting, title: "Waiting on the board", status: "blocked" },
      { id: merged, title: "Merged but blocked", status: "blocked", prs: [{ state: "merged" }] },
    ]);
    await client.control("/map/seed", {
      ...base,
      stages: [{ id: "s", title: "Stage", order: 1 }],
      items: [
        { id: "waiting", stageId: "s", title: "Waiting", task: taskFor(waiting) },
        { id: "merged", stageId: "s", title: "Merged", task: taskFor(merged) },
      ],
    });
    const map = await readMap(machine);
    expect(map.items.find((item) => item.id === "waiting")?.status).toBe("planned");
    expect(map.items.find((item) => item.id === "merged")?.status).toBe("built");
    expect(map.items.every((item) => item.blockedBy.length === 0)).toBe(true);
  });

  it("carries task from the plan ref even when the board has no card for it", async () => {
    const machine = await enrol();
    await seedBoard(machine, []);
    const ref = { tracker: "github", scope: "example-org/example-app", key: "9001" };
    await client.control("/map/seed", {
      ...base,
      stages: [{ id: "s", title: "Stage", order: 1 }],
      items: [
        { id: "closed", stageId: "s", title: "Closed issue", task: ref },
        { id: "plain", stageId: "s", title: "No task" },
      ],
    });
    const map = await readMap(machine);
    const closed = map.items.find((item) => item.id === "closed");
    expect(closed?.task?.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(closed?.task?.title).toBeTruthy();
    expect(closed?.task?.ref).toMatchObject(ref);
    expect(closed?.task?.ref.url).toContain("/9001");
    expect(Number.isFinite(Date.parse(closed?.task?.openedAt ?? ""))).toBe(true);
    expect(closed?.task?.closedAt === null || typeof closed?.task?.closedAt === "string").toBe(
      true,
    );
    expect(map.items.find((item) => item.id === "plain")?.task).toBeUndefined();
    // The same ref gives the same id on the next read.
    expect((await readMap(machine)).items.find((item) => item.id === "closed")?.task?.id).toBe(
      closed?.task?.id,
    );
  });

  it("keeps a higher status on a dependant, and counts every item once", async () => {
    const machine = await enrol();
    const dead = id();
    const done = id();
    const taskFor = await seedBoard(machine, [
      { id: dead, title: "Dead", status: "ruled_dead" },
      { id: done, title: "Done", status: "checked" },
    ]);
    await client.control("/map/seed", {
      plan: {
        ...base,
        stages: [
          { id: "a", title: "A", order: 1 },
          { id: "b", title: "B", order: 2 },
          { id: "c", title: "C, nothing in it", order: 3 },
        ],
        items: [
          { id: "dead", stageId: "a", title: "Dead", task: taskFor(dead) },
          { id: "done", stageId: "a", title: "Done", task: taskFor(done), restsOn: ["dead"] },
          { id: "blocked", stageId: "b", title: "Blocked", restsOn: ["dead"] },
          { id: "plain", stageId: "b", title: "Plain" },
          { id: "set", stageId: "b", title: "Set by seed" },
        ],
      },
      statuses: { set: "built" },
    });
    const map = await readMap(machine);
    // checked outranks the propagation rule.
    expect(map.items.find((item) => item.id === "done")?.status).toBe("checked");
    expect(map.items.find((item) => item.id === "set")?.status).toBe("built");
    expect(map.counters.byStatus).toEqual({
      ruled_dead: 1,
      checked: 1,
      blocked: 1,
      planned: 1,
      built: 1,
    });
    expect(map.counters.byStage).toEqual({
      a: { ruled_dead: 1, checked: 1 },
      b: { blocked: 1, planned: 1, built: 1 },
      c: {},
    });
  });

  it("is not measured, with a reason, for a plan with a cycle", async () => {
    const machine = await enrol();
    await client.control("/map/seed", {
      ...base,
      stages: [{ id: "s", title: "Stage", order: 1 }],
      items: [
        { id: "a", stageId: "s", title: "A", restsOn: ["b"] },
        { id: "b", stageId: "s", title: "B", restsOn: ["a"] },
      ],
    });
    // The section stays advertised: the plan is configured, it just cannot be used.
    expect(await mapSection(machine)).toBeDefined();
    const map = await readMap(machine);
    expect(map.state).toBe("not_measured");
    expect(map.notMeasured[0]?.reason).toBe("malformed");
    expect(map.notMeasured[0]?.detail).toMatch(/cycle/i);
    expect(map.items).toEqual([]);
    expect(map.stages).toEqual([]);
  });

  it.each([
    ["an item whose rests-on names nothing", { restsOn: ["ghost"] }, /ghost/],
    ["an item in a stage that does not exist", { stageId: "nowhere" }, /nowhere/],
  ])("is not measured, with a reason, for %s", async (_name, patch, detail) => {
    const machine = await enrol();
    await client.control("/map/seed", {
      ...base,
      stages: [{ id: "s", title: "Stage", order: 1 }],
      items: [{ id: "a", stageId: "s", title: "A", ...patch }],
    });
    const map = await readMap(machine);
    expect(map.state).toBe("not_measured");
    expect(map.notMeasured[0]?.reason).toBe("malformed");
    expect(map.notMeasured[0]?.detail).toMatch(detail);
  });

  it("is not measured when the plan file cannot be read, and recovers with a valid one", async () => {
    const machine = await enrol();
    await client.control("/map/seed", { plan: { unreadable: true } });
    const broken = await readMap(machine);
    expect(broken.state).toBe("not_measured");
    expect(broken.notMeasured[0]?.reason).toBe("unreachable");
    await client.control("/map/seed", {
      ...base,
      stages: [{ id: "s", title: "Stage", order: 1 }],
      items: [{ id: "a", stageId: "s", title: "A" }],
    });
    const fixed = await readMap(machine);
    expect(fixed.state).toBe("ok");
    expect(fixed.items.map((item) => item.id)).toEqual(["a"]);
  });

  it("stops advertising the map when the plan is removed", async () => {
    const machine = await enrol();
    await client.control("/map/seed", {
      ...base,
      stages: [{ id: "s", title: "Stage", order: 1 }],
      items: [],
    });
    expect(await mapSection(machine)).toBeDefined();
    await client.control("/map/seed", { plan: null });
    expect(await mapSection(machine)).toBeUndefined();
    expect((await headFiles(machine)).map).toBeUndefined();
  });
});

describe("team", () => {
  interface TeamSession {
    id: string;
    personId: string;
    state: string;
    since: string;
    machineId?: string;
    parentId?: string;
    waiting?: string;
  }
  const filesFor = async (machine: Enrolled) => {
    await client.rebuildSnapshot(machine.login);
    const head = await call(machine, "GET", "/relay/v1/snapshot/head");
    return (head.body as { files: Record<string, string> }).files;
  };
  const readFile = async (machine: Enrolled, ref: string, schema: string) => {
    const file = await call(machine, "GET", "/relay/v1/snapshot/files/" + ref.slice(7));
    expectSchema(schema, file.body);
    return file.body;
  };
  const readTeam = async (machine: Enrolled) => {
    const files = await filesFor(machine);
    await readFile(machine, files.team!, "SnapshotTeam");
    return (await readFile(machine, files["team.people"]!, "SnapshotTeamPeople")) as {
      people: { id: string; login: string; role: string; presence: string }[];
    };
  };
  const sessionsOf = async (machine: Enrolled, reader = machine) => {
    const person = (await readTeam(reader)).people.find((p) => p.login === machine.login)!;
    const files = await filesFor(reader);
    const sessions: TeamSession[] = [];
    for (const [key, ref] of Object.entries(files)) {
      if (key === "team.hallway" || key.startsWith("team.room.")) {
        const room = (await readFile(reader, ref, "SnapshotTeamRoom")) as {
          sessions: TeamSession[];
        };
        sessions.push(...room.sessions.filter((s) => s.personId === person.id));
      }
    }
    return sessions;
  };
  const sendFacts = async (machine: Enrolled, activity: ReadonlyArray<Record<string, unknown>>) => {
    const body = { ...factsFor(machine), activity };
    const sent = await call(machine, "POST", "/relay/v1/facts", body);
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  };
  const exampleActivity = () =>
    (readExample("facts-request.json") as { activity: Array<Record<string, unknown>> }).activity;

  it("advertises the team section and names the team file in the head", async () => {
    const machine = await enrol();
    const reply = await call(machine, "GET", "/relay/v1/capabilities");
    expectSchema("Capabilities", reply.body);
    const sections = (reply.body as { sections: Array<{ kind: string }> }).sections;
    expect(sections.some((section) => section.kind === "team")).toBe(true);
    const team = await readTeam(machine);
    const me = team.people.find((person) => person.login === machine.login);
    expect(me?.role).toEqual({ id: "founder", name: "Founder" });
    expect(me?.presence).toBe("off");
  });

  it("publishes a self-set status live and in the next directory", async () => {
    const machine = await enrol();
    const reader = await openEvents(machine);
    try {
      const edit = { presence: "focusing", status: { text: "Reviewing" } };
      const reply = await call(machine, "PUT", "/relay/v1/team/me", edit);
      expect(reply.status).toBe(200);
      expect(await nextEvent(reader)).toMatchObject({
        event: "team.changed",
        data: { person: reply.body },
      });
      expect((await readTeam(machine)).people.find((p) => p.login === machine.login)).toMatchObject(
        edit,
      );
    } finally {
      await reader.cancel();
    }
  });

  it("hides sessions when the heartbeat omits sharing", async () => {
    const machine = await enrol();
    const facts = factsFor(machine);
    await sendFacts(machine, exampleActivity());
    expect(await sessionsOf(machine)).not.toHaveLength(0);
    const { share: _share, ...hidden } = facts.machine as typeof facts.machine & { share: string };
    expect(
      (await call(machine, "POST", "/relay/v1/facts", { ...facts, machine: hidden })).status,
    ).toBe(200);
    expect(await sessionsOf(machine)).toEqual([]);
  });

  it("counts a waiting helper under its lead and filters names and usage on each heartbeat", async () => {
    const owner = await enrol();
    const viewer = await enrol({ role: "staff" });
    const id = "task_" + randomText(5);
    await client.control("/board/seed", {
      tasks: [{ id, title: "Room task", holder: owner.login }],
    });
    const [lead, helper, stop] = exampleActivity();
    const sessions = [
      { ...lead, sessionId: "lead_" + id, taskId: id },
      { ...helper, sessionId: "helper_" + id, parentSessionId: "lead_" + id, taskId: id },
      { ...stop, sessionId: "stop_" + id, taskId: id },
    ];
    const facts = factsFor(owner);
    for (const named of [true, false]) {
      await call(owner, "POST", "/relay/v1/facts", {
        ...facts,
        machine: {
          ...facts.machine,
          share: named ? "agents_and_name" : "agents_only",
          shareUsage: named,
        },
        activity: sessions,
      });
      const directory = await readTeam(viewer);
      const person = directory.people.find((p) => p.login === owner.login)!;
      const files = await filesFor(viewer);
      const team = await readFile(viewer, files.team!, "SnapshotTeam");
      expect(team).toMatchObject({
        agents: expect.arrayContaining([
          expect.objectContaining({
            personId: person.id,
            counts: { waiting: 1, working: 0, idle: 0, notHeardFrom: 0, stopped: 1 },
            rooms: [{ board: "platform", waiting: 1 }],
          }),
        ]),
      });
      const page = await call(viewer, "GET", "/relay/v1/team/rooms/platform/sessions");
      expectSchema("SnapshotTeamRoom", page.body);
      const own = (
        page.body as { sessions: { id: string; machineId?: string; stopReason?: string }[] }
      ).sessions.filter((s) => s.id.endsWith(id));
      expect(own).toHaveLength(3);
      expect(own.map((s) => s.machineId)).toEqual(
        Array(3).fill(named ? owner.machineId : undefined),
      );
      expect(own.find((s) => s.id === "stop_" + id)?.stopReason).toBe(
        named ? "usage_limit" : undefined,
      );
    }
  });

  it.skipIf(external).each(["company", "community"] as const)(
    "serves the %s scale fixture through Team v2",
    async (preset) => {
      const relay = await startFakeRelay({ officeFixture: preset, autoApprove: false });
      const original = client;
      client = new RelayClient(relay.url);
      try {
        const reader = await enrol({ login: "ada-example" });
        const files = await filesFor(reader);
        const summary = (await readFile(reader, files.team!, "SnapshotTeam")) as {
          agents: { personId: string }[];
          agentsNextCursor: string | null;
          rooms: { desks: number; counts: { working: number } }[];
          people: { total: number };
        };
        expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThanOrEqual(65536);
        expect(summary.rooms).toHaveLength(50);
        expect(summary.people.total).toBe(preset === "company" ? 500 : 2000);
        if (preset === "company") {
          expect(
            summary.rooms.every((room) => room.desks === 10 && room.counts.working === 30),
          ).toBe(true);
          expect(summary.agentsNextCursor).toEqual(expect.any(String));
          const page = await call(
            reader,
            "GET",
            "/relay/v1/team/agents?cursor=" + encodeURIComponent(summary.agentsNextCursor!),
          );
          expectSchema("TeamAgentsPage", page.body);
          expect((page.body as { agents: { personId: string }[] }).agents[0]?.personId).not.toBe(
            summary.agents.at(-1)?.personId,
          );
        } else {
          const last = await call(reader, "GET", "/relay/v1/team/people?q=builder-1999");
          expect(last.body).toMatchObject({ people: [{ login: "builder-1999" }] });
        }
      } finally {
        client = original;
        await relay.close();
      }
    },
  );
  it("fits 500 agent owners into a paged summary and finds directory entries past the first page", async () => {
    const isolated = external
      ? undefined
      : await startFakeRelay({ autoApprove: false, retryAfterMs: 0 });
    const original = client;
    if (isolated) client = new RelayClient(isolated.url);
    try {
      const reader = await enrol();
      const prefix = newLogin();
      const activity = exampleActivity()[0]!;
      const taskId = "t_" + randomText(4);
      await client.control("/board/seed", { tasks: [{ id: taskId, title: "Platform task" }] });
      for (let index = 0; index < 500; index++) {
        const owner = await enrol({ login: prefix + "-" + String(index).padStart(3, "0") });
        await sendFacts(owner, [{ ...activity, sessionId: "s_" + index, taskId }]);
      }
      const files = await filesFor(reader);
      const summary = (await readFile(reader, files.team!, "SnapshotTeam")) as {
        agents: { personId: string }[];
        agentsNextCursor: string | null;
        rooms: { counts: { working: number } }[];
      };
      expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThanOrEqual(65536);
      expect(summary.rooms[0]?.counts.working).toBeGreaterThanOrEqual(500);
      expect(summary.agentsNextCursor).toEqual(expect.any(String));
      const ids = new Set(summary.agents.map((row) => row.personId));
      let cursor = summary.agentsNextCursor;
      while (cursor) {
        const page = await call(
          reader,
          "GET",
          "/relay/v1/team/agents?cursor=" + encodeURIComponent(cursor),
        );
        expectSchema("TeamAgentsPage", page.body);
        const next = page.body as { agents: { personId: string }[]; nextCursor: string | null };
        for (const row of next.agents) {
          expect(ids.has(row.personId)).toBe(false);
          ids.add(row.personId);
        }
        cursor = next.nextCursor;
      }
      const target = "/relay/v1/team/people?q=" + prefix;
      const first = await call(reader, "GET", target);
      expectSchema("SnapshotTeamPeople", first.body);
      const page = first.body as { people: { id: string }[]; nextCursor: string };
      expect(page.people).toHaveLength(100);
      expect(typeof page.nextCursor).toBe("string");
      expect(
        (await call(reader, "GET", target + "&cursor=" + encodeURIComponent(page.nextCursor))).body,
      ).toMatchObject({
        people: expect.arrayContaining([expect.objectContaining({ login: prefix + "-100" })]),
      });
      const last = await call(reader, "GET", target + "-499");
      expect(last.body).toMatchObject({ people: [{ login: prefix + "-499" }], nextCursor: null });
      if (isolated) expect(ids.size).toBe(500);
    } finally {
      client = original;
      await isolated?.close();
    }
  });

  it("restricts meeting writes and serves scoped agent heartbeats", async () => {
    const founder = await enrol();
    const staff = await enrol({ role: "staff" });
    for (const path of ["office", "rooms/platform"]) {
      const target = "/relay/v1/team/" + path;
      expect((await call(staff, "PUT", target, { meetingUrl: null })).status).toBe(403);
      expect(
        (await call(founder, "PUT", target, { meetingUrl: "http://example.org" })).status,
      ).toBe(400);
      expect(
        (await call(founder, "PUT", target, { meetingUrl: "https://meet.example.org" })).status,
      ).toBe(204);
      expect((await call(founder, "PUT", target, { meetingUrl: null })).status).toBe(204);
    }
    const id = "s_" + randomText(5);
    await sendFacts(founder, [{ ...exampleActivity()[0], sessionId: id }]);
    const heard = await call(staff, "GET", "/relay/v1/team/heartbeats?sessions=" + id);
    expectSchema("TeamHeartbeats", heard.body);
    expect(heard.body).toMatchObject({ sessions: [{ id }] });
    expect(
      (
        await call(
          staff,
          "GET",
          "/relay/v1/team/heartbeats?sessions=" + Array(51).fill(id).join(","),
        )
      ).status,
    ).toBe(400);
  });
  it("includes a directory member before their first sign-in", async () => {
    const reader = await enrol();
    const person = (await readTeam(reader)).people.find((entry) => entry.login === "cy-example");
    expect(person).toMatchObject({ role: { id: "staff", name: "Staff" }, presence: "off" });
    expect((await listMachines(reader)).map((machine) => machine.ownerId)).not.toContain(
      person?.id,
    );
  });

  it("lists every live session with its parent, retains stopped sessions, and carries no titles or branches", async () => {
    const machine = await enrol();
    const other = await enrol({ role: "staff" });
    await sendFacts(machine, exampleActivity());
    const sessions = await sessionsOf(machine, other);
    expect(sessions?.map((session) => [session.id, session.state])).toEqual([
      ["s_q8Lm2Vx", "working"],
      ["s_h3Pw7Nc", "waiting"],
      ["s_c4Rt1Ya", "stopped"],
    ]);
    const helper = sessions?.find((session) => session.id === "s_h3Pw7Nc");
    expect(helper?.parentId).toBe("s_q8Lm2Vx");
    expect(helper?.waiting).toBe("permission");
    expect(helper?.machineId).toBeUndefined();

    const raw = JSON.stringify(await readTeam(other));
    expect(raw).not.toContain("work/42-guild-invites");
    expect(raw).not.toContain("th_01JDX3K9");
  });

  it("reads a finished turn as idle, not waiting", async () => {
    const machine = await enrol();
    await sendFacts(machine, [
      {
        sessionId: "s_idle01",
        threadId: "th_idle01",
        projectKey: `sha256:${"a".repeat(64)}`,
        provider: "codex",
        state: "waiting",
        waiting: "input",
        processRunning: false,
        startedAt: "2026-11-26T09:00:00Z",
        lastSeenAt: "2026-11-26T09:05:00Z",
      },
    ]);
    const sessions = await sessionsOf(machine);
    expect(sessions).toHaveLength(1);
    expect(sessions?.[0]?.state).toBe("idle");
    expect(sessions?.[0]?.waiting).toBeUndefined();
  });

  it("keeps since while the state holds, and moves it when the state changes", async () => {
    const machine = await enrol();
    const working = exampleActivity().slice(0, 1);
    await sendFacts(machine, working);
    // A minute back, still heard from: the state's start moves back with it.
    await client.control("/machines/age", { machineId: machine.machineId, seconds: 60 });
    const first = (await sessionsOf(machine))?.[0]?.since;
    await sendFacts(machine, working);
    expect((await sessionsOf(machine))?.[0]?.since).toBe(first);
    await sendFacts(machine, [
      { ...working[0], state: "waiting", waiting: "question", processRunning: true },
    ]);
    const moved = (await sessionsOf(machine))?.[0];
    expect(moved?.state).toBe("waiting");
    expect(moved?.since).not.toBe(first);
  });

  it("marks sessions not heard from after 90 seconds, and drops them after 24 hours", async () => {
    const machine = await enrol();
    await sendFacts(machine, exampleActivity());
    await client.control("/machines/age", { machineId: machine.machineId, seconds: 120 });
    const unheard = await sessionsOf(machine);
    expect(unheard.map((s) => s.state).sort()).toEqual([
      "not_heard_from",
      "not_heard_from",
      "stopped",
    ]);
    expect(unheard?.every((session) => session.waiting === undefined)).toBe(true);
    const listed = (await listMachines(machine)).find((entry) => entry.id === machine.machineId);
    expect(unheard?.[0]?.since).toBe(listed?.lastHeardAt);
    await client.control("/machines/age", { machineId: machine.machineId, seconds: 24 * 3600 });
    expect(await sessionsOf(machine)).toEqual([]);
  });
});

describe("event retention", () => {
  // The 24-hour bound cannot be waited out; only the fake can shorten it.
  it.skipIf(external !== undefined)(
    "sends reset when the resume point is over 24 hours old",
    async () => {
      let eventTime = 0;
      const short = await startFakeRelay({
        autoApprove: false,
        retryAfterMs: 0,
        eventClock: () => eventTime,
      });
      const original = client;
      try {
        client = new RelayClient(short.url);
        const machine = await enrol();
        const reader = await openEvents(machine);
        await client.control("/needs", { machineId: machine.machineId, count: 1 });
        const first = await nextEvent(reader);
        await reader.cancel();
        await client.control("/needs", { machineId: machine.machineId, count: 1 });
        // Exactly 24 hours later the replay still works; a millisecond more and it resets.
        eventTime = 24 * 60 * 60 * 1000;
        const replay = await openEvents(machine, first.id);
        expect((await nextEvent(replay)).event).toBe("needs.changed");
        await replay.cancel();
        eventTime += 1;
        const late = await openEvents(machine, first.id);
        expect((await nextEvent(late)).event).toBe("reset");
        await late.cancel();
      } finally {
        client = original;
        await short.close();
      }
    },
  );
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

describe("opt-in health", () => {
  it("omits unconfigured health from Today, sections and head", async () => {
    const viewer = await enrol();
    const read = async (path: string) => (await call(viewer, "GET", "/relay/v1/" + path)).body;
    expect(await read("today")).not.toHaveProperty("health");
    expect(await read("snapshot/head")).not.toHaveProperty("files.health");
    const capabilities = (await read("capabilities")) as { sections: Array<{ kind: string }> };
    expect(capabilities.sections.find((s) => s.kind === "health")).toBeUndefined();
    expect(capabilities.sections.find((s) => s.kind === "board")).toMatchObject({
      params: { staleSeconds: 21600, expirySeconds: 86400 },
    });
  });

  it("authenticates and deduplicates deliveries, then resolves a critical need", async () => {
    const configuredOrigin = process.env.BANNERET_RELAY_HEALTH_URL;
    const secret = configuredOrigin ? process.env.BANNERET_RELAY_HOOK_SECRET : randomText(32);
    if (!secret) throw new Error("Set BANNERET_RELAY_HOOK_SECRET for the configured relay.");
    const config = {
      healthSources: [{ id: "alerts", kind: "webhook", secret }],
      board: { staleSeconds: 30, expirySeconds: 90 },
      dashboards: [{ id: "metrics", title: "Metrics", url: "https://metrics.example.org" }],
    };
    const relay = configuredOrigin ? undefined : await startFakeRelay(config);
    const local = new RelayClient(configuredOrigin ?? relay!.url);
    try {
      const key = generateMachineKey();
      const start = await local.send(key, "POST", "/relay/v1/enroll/start", {
        body: { publicKey: key.publicKey, machine: machineFacts("env_" + randomText(12)) },
      });
      const pairingId = (start.body as { pairingId: string }).pairingId;
      const approved = await local.send(key, "POST", "/relay/v1/enroll/poll", {
        body: { pairingId },
      });
      const { token, machineId } = approved.body as { token: string; machineId: string };
      const read = async (path: string) =>
        (await local.send(key, "GET", "/relay/v1/" + path, { token, device: machineId })).body;
      const timestamp = String(Math.floor(Date.parse(local.now()) / 1000));
      const post = async (body: string, time = timestamp, signingSecret = secret) => {
        const signature = NodeCrypto.createHmac("sha256", signingSecret)
          .update(time + "." + body)
          .digest("hex");
        return (
          await local.send(key, "POST", "/relay/v1/hooks/alerts", {
            unsigned: true,
            rawBody: Buffer.from(body),
            headers: { "X-Alarm-Signature": signature, "X-Alarm-Timestamp": time },
          })
        ).status;
      };
      const alarm = {
        id: "queue",
        sourceId: "alerts",
        title: "Queue is full",
        severity: "critical",
        firedAt: local.now(),
      };
      const body = JSON.stringify(alarm);
      expect(await read("capabilities")).toMatchObject({
        dashboards: config.dashboards,
        sections: expect.arrayContaining([
          expect.objectContaining({ kind: "health" }),
          expect.objectContaining({ kind: "board", params: config.board }),
        ]),
      });
      const taskId = "clock_" + randomText(8);
      await local.control("/board/seed", {
        tasks: [{ id: taskId, title: "Lease clocks", column: "taken", holder: "ada-example" }],
      });
      await local.control("/lease/age", { taskId, hours: 1 / 60 });
      const task = (await read("tasks/" + taskId)) as {
        lease?: { state: string };
        card?: { lease?: { state: string } };
      };
      expect(task.card?.lease?.state ?? task.lease?.state).toBe("stale");
      expect(await post(body, timestamp, "wrong")).toBe(401);
      expect(await post(body, String(Number(timestamp) - 301))).toBe(401);
      expect(await post("a".repeat(1024 * 1024 + 1))).toBe(413);
      expect(await post(body)).toBe(204);
      expect(await post(body)).toBe(401);
      expect(await read("today")).toMatchObject({
        health: { alarms: [alarm] },
        needsYou: { items: [expect.objectContaining({ kind: "health", title: alarm.title })] },
      });
      expect(await read("snapshot/head")).toHaveProperty("files.health");
      expect(await post(JSON.stringify({ ...alarm, resolvedAt: alarm.firedAt }))).toBe(204);
      expect(await read("today")).toMatchObject({
        health: { alarms: [] },
        needsYou: { items: [] },
      });
      expect(await read("needs")).toMatchObject({ items: [] });
      for (let i = 0; i < 54; i++) await post(body);
      expect(await post(body)).toBe(429);
    } finally {
      await relay?.close();
    }
  });

  it("caps active alarms per source and overall, by severity and then recency", async () => {
    const configuredOrigin = process.env.BANNERET_RELAY_HEALTH_URL;
    const secret = configuredOrigin ? process.env.BANNERET_RELAY_HOOK_SECRET : randomText(32);
    if (!secret) throw new Error("Set BANNERET_RELAY_HOOK_SECRET for the configured relay.");
    const sources = Array.from({ length: 6 }, (_, i) => ({
      id: `cap_${i}`,
      kind: "webhook",
      secret,
    }));
    const relay = configuredOrigin ? undefined : await startFakeRelay({ healthSources: sources });
    const local = new RelayClient(configuredOrigin ?? relay!.url);
    try {
      const key = generateMachineKey();
      const start = await local.send(key, "POST", "/relay/v1/enroll/start", {
        body: { publicKey: key.publicKey, machine: machineFacts("env_" + randomText(12)) },
      });
      const approved = await local.send(key, "POST", "/relay/v1/enroll/poll", {
        body: { pairingId: (start.body as { pairingId: string }).pairingId },
      });
      const { token, machineId } = approved.body as { token: string; machineId: string };
      const read = async (path: string) =>
        (await local.send(key, "GET", "/relay/v1/" + path, { token, device: machineId })).body;
      const timestamp = String(Math.floor(Date.parse(local.now()) / 1000));
      for (const [index, source] of sources.entries()) {
        // The last source adds one older critical and one newer info alarm.
        const count = index === 5 ? 2 : 21;
        for (let i = 0; i < count; i++) {
          const severity = i === 0 && index >= 4 ? "critical" : index === 5 ? "info" : "warning";
          const body = JSON.stringify({
            id: `a_${index}_${i}`,
            sourceId: source.id,
            severity,
            title: "Test alarm",
            firedAt: rfc3339(Date.UTC(2026, 0, 1, 0, index, i)),
          });
          const signature = NodeCrypto.createHmac("sha256", secret)
            .update(timestamp + "." + body)
            .digest("hex");
          const reply = await local.send(key, "POST", "/relay/v1/hooks/" + source.id, {
            unsigned: true,
            rawBody: Buffer.from(body),
            headers: { "X-Alarm-Signature": signature, "X-Alarm-Timestamp": timestamp },
          });
          expect(reply.status).toBe(204);
        }
      }
      const { files } = (await read("snapshot/head")) as { files: { health: string } };
      const health = (await read("snapshot/files/" + files.health.slice(7))) as {
        alarms: { id: string }[];
      };
      expectSchema("HealthBlock", health);
      const ids = health.alarms.map((alarm) => alarm.id);
      expect(ids).toHaveLength(100);
      expect(ids).toContain("a_5_0");
      expect(ids).not.toContain("a_5_1");
      expect(ids).not.toContain("a_0_1");
      expect(ids).toContain("a_4_0");
      expect(ids).not.toContain("a_4_1");
      for (let index = 0; index < 4; index++) expect(ids).not.toContain(`a_${index}_0`);
      expect(await read("today")).toMatchObject({ health: { alarms: health.alarms } });
    } finally {
      await relay?.close();
    }
  });
});

describe("chat access and role administration", () => {
  const base = "/relay/v1";
  const me = async (machine: Enrolled) =>
    (await call(machine, "GET", base + "/capabilities")).body as {
      me: { id: string; role: { id: string }; permissions: string[] };
    };
  it("applies role edits to existing sessions and serves private metadata until a manager joins", async () => {
    const founder = await enrol(),
      worker = await enrol({ role: "staff" }),
      other = await enrol();
    const workerId = (await me(worker)).me.id,
      adminId = (await me(other)).me.id;
    const id = "policy_" + randomText(6).toLowerCase();
    const path = base + "/roles/" + id;
    const input = {
      name: "Review staff",
      forOutside: false,
      permissions: { "scope.boards": [], "scope.people": "shared_channels" },
    };
    expectError(await call(worker, "GET", base + "/roles"), 403, "role_permission_missing");
    expectSchema("RoleDetail", (await call(founder, "PUT", path, input)).body);
    expect(
      (await call(founder, "PUT", base + "/staff/" + workerId + "/role", { roleId: id })).status,
    ).toBe(204);
    expect((await me(worker)).me.role.id).toBe(id);
    expectError(await call(founder, "DELETE", path), 409, "role_in_use");
    const head = (await call(worker, "GET", base + "/snapshot/head")).body as {
      files: Record<string, string>;
    };
    expect(head.files).not.toHaveProperty("team");
    expect(Object.keys(head.files).some((k) => k.startsWith("board."))).toBe(false);
    expect(
      (await call(founder, "PUT", path, { ...input, permissions: { "hub.team": true } })).status,
    ).toBe(200);
    expect((await me(worker)).me.permissions).toContain("hub.team");
    const created = await call(founder, "POST", base + "/chat/conversations", {
      kind: "channel",
      name: "private-" + randomText(6),
      template: "private",
    });
    expectSchema("ChatConversation", created.body);
    const channel = (created.body as { id: string }).id,
      route = base + "/chat/conversations/" + channel;
    expectError(await call(other, "GET", route + "/messages"), 404, "not_found");
    expect((await call(other, "GET", base + "/chat/directory?limit=100")).body).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({
          id: channel,
          me: expect.objectContaining({ can: expect.objectContaining({ read: false }) }),
        }),
      ]),
    });
    expect((await call(other, "PUT", route + "/members/" + adminId)).body).toMatchObject({
      addedBy: { id: adminId },
    });
    expect((await call(other, "GET", route + "/messages")).body).toMatchObject({
      items: [expect.objectContaining({ kind: "system" })],
    });
    expect(
      (await call(founder, "PUT", base + "/staff/" + workerId + "/role", { roleId: "staff" }))
        .status,
    ).toBe(204);
    expect((await call(founder, "DELETE", path)).status).toBe(204);
  });
  it("admits an outside requester, delivers their mention to the inbox and keeps it out of the wake queue", async () => {
    const creator = await enrol(),
      guest = await enrol({ admission: "outside" });
    const guestId = (await me(guest)).me.id,
      chat = base + "/chat/";
    expectError(
      await call(creator, "PUT", base + "/staff/" + guestId + "/role", { roleId: "staff" }),
      409,
      "role_not_for_outside",
    );
    const created = await call(creator, "POST", chat + "conversations", {
      kind: "channel",
      name: "community-" + randomText(6),
      template: "community",
    });
    const channel = (created.body as { id: string }).id,
      path = chat + "conversations/" + channel;
    const requested = await call(guest, "POST", path + "/requests", {
      note: "I maintain this repo.",
    });
    expectSchema("ChatJoinRequest", requested.body);
    const request = chat + "requests/" + (requested.body as { id: string }).id;
    expect((await call(creator, "GET", base + "/needs")).body).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ kind: "chat_join_requests", conversationId: channel, count: 1 }),
      ]),
    });
    expect((await call(creator, "POST", request + "/approve")).body).toMatchObject({
      state: "approved",
    });
    expectError(await call(creator, "POST", request + "/decline"), 409, "chat_request_closed");
    const handle = "h_" + randomText(6);
    await call(creator, "PUT", chat + "me/settings", {
      agentWakeDefault: "owner",
      agentAsks: { default: "approve", auto: [], maxTokens: 200000, maxSeconds: 900 },
      agentsPaused: false,
      agentsReadMyDms: false,
    });
    expect(
      (
        await call(creator, "PUT", chat + "handles/" + handle, {
          threadRef: "thread1",
          provider: "codex",
          name: "reviewer",
          machineId: creator.machineId,
        })
      ).body,
    ).toMatchObject({ wake: "owner" });
    expect((await call(creator, "PUT", chat + "me/agents/wake", { wake: "everyone" })).status).toBe(
      204,
    );
    expect(
      (
        await call(guest, "POST", chat + "messages", {
          conversationId: channel,
          text: "@" + creator.login + "/reviewer release notes",
          key: randomText(6),
        })
      ).status,
    ).toBe(200);
    expect((await call(creator, "GET", chat + "deliveries")).body).toMatchObject({ items: [] });
    expectError(await call(guest, "POST", chat + "inbox", { asHandle: handle }), 403, "forbidden");
    const inbox = () => call(creator, "POST", chat + "inbox", { asHandle: handle });
    expect((await inbox()).body).toMatchObject({
      items: [expect.objectContaining({ state: "consumed", wakes: false })],
    });
    expect((await inbox()).body).toMatchObject({ items: [] });
    await client.control("/outside/check", { login: guest.login, reason: "outside_check_pending" });
    expect((await call(guest, "GET", base + "/capabilities")).body).toMatchObject({
      error: { code: "unavailable", retryable: true, details: { reason: "outside_check_pending" } },
    });
    await client.control("/outside/check", { login: guest.login, reason: null });
    expect((await call(guest, "GET", path + "/members")).status).toBe(200);
    await client.control("/outside/check", { login: guest.login, reason: "outside_grant_lost" });
    expect((await call(guest, "GET", base + "/capabilities")).body).toMatchObject({
      error: { code: "token_revoked", details: { reason: "outside_grant_lost" } },
    });
  });
});

describe("chat contract", () => {
  async function sharedAskThread() {
    const asker = await enrol(),
      answerer = await enrol(),
      chat = "/relay/v1/chat/";
    const register = async (machine: Enrolled, name: string) => {
      const id = "h_" + randomText(8);
      const reply = await call(machine, "PUT", chat + "handles/" + id, {
        threadRef: id,
        name,
        provider: "codex",
        machineId: machine.machineId,
      });
      expectSchema("ChatHandle", reply.body);
      return { id, owner: (reply.body as { owner: { id: string; login: string } }).owner };
    };
    const from = await register(asker, "builder"),
      to = await register(answerer, "reader");
    const created = await call(asker, "POST", chat + "conversations", {
      kind: "channel",
      template: "team",
      name: "work-" + randomText(4),
    });
    const conversationId = (created.body as { id: string }).id;
    await call(asker, "PUT", chat + "conversations/" + conversationId + "/members/" + to.owner.id);
    const root = await call(asker, "POST", chat + "messages", {
      conversationId,
      text: "Release question",
      key: "root",
    });
    const threadRootId = (root.body as { id: string }).id;
    const newAsk = {
      to: { kind: "agent", handle: to.id },
      question: "Which file?",
      doneWhen: "Name the file.",
      asHandle: from.id,
      threadRootId,
      key: "file",
    };
    return { asker, answerer, chat, from, to, conversationId, threadRootId, newAsk };
  }
  it("keeps a cross-owner mention in the inbox and sends one callback after a draft is confirmed", async () => {
    const { asker, answerer, chat, from, to, conversationId, threadRootId, newAsk } =
      await sharedAskThread();
    await call(asker, "POST", chat + "messages", {
      conversationId,
      threadRootId,
      text: "@" + answerer.login + "/reader heads up",
      asHandle: from.id,
      key: "mention",
    });
    expect((await call(answerer, "POST", chat + "inbox", { asHandle: to.id })).body).toMatchObject({
      items: [{ wakes: false, reason: "mention" }],
    });
    const ask = await call(asker, "POST", chat + "asks", newAsk);
    expect(ask.body).toMatchObject({
      state: "waiting_owner",
      to: { kind: "agent", handle: to.id, owner: to.owner },
    });
    const path = chat + "asks/" + (ask.body as { id: string }).id;
    expect((await call(answerer, "GET", "/relay/v1/needs")).body).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ kind: "agent_ask", owner: from.owner, count: 1 }),
      ]),
    });
    expect((await call(asker, "POST", path + "/decision", { allow: "once" })).status).toBe(403);
    expect(
      (await call(answerer, "POST", path + "/decision", { allow: "draft" })).body,
    ).toMatchObject({ state: "open", mode: "draft" });
    expect((await call(answerer, "GET", chat + "deliveries")).body).toMatchObject({
      items: [{ reason: "ask", wakes: true }],
    });
    expect(
      (
        await call(answerer, "POST", path + "/answer", {
          text: "private draft",
          asHandle: to.id,
          receipt: { handle: to.id, tokens: 10, seconds: 2, tools: ["read"] },
        })
      ).body,
    ).toMatchObject({ state: "draft" });
    const list = await call(asker, "GET", chat + "asks?role=asker");
    expect(JSON.stringify(list.body)).not.toContain("private draft");
    expect(
      (await call(answerer, "POST", path + "/confirm", { post: true, text: "public answer" })).body,
    ).toMatchObject({ state: "answered", answer: { text: "public answer" } });
    expectError(await call(answerer, "POST", path + "/confirm", { post: true }), 409, "ask_closed");
    expect((await call(asker, "GET", chat + "deliveries")).body).toMatchObject({
      items: [{ reason: "ask_result", wakes: true }],
    });
  });
  it("expires an offline ask from its write deadline and refuses a late owner decision", async () => {
    const { asker, answerer, chat, newAsk } = await sharedAskThread();
    const created = await call(asker, "POST", chat + "asks", { ...newAsk, timeoutSeconds: 1 });
    expect(created.body).toMatchObject({ state: "waiting_owner" });
    const id = (created.body as { id: string }).id;
    await expect
      .poll(async () => (await call(asker, "GET", chat + "deliveries")).body, { timeout: 5000 })
      .toMatchObject({
        items: [{ reason: "ask_result", message: { ask: { id, state: "expired" } } }],
      });
    expectError(
      await call(answerer, "POST", chat + "asks/" + id + "/decision", { allow: "once" }),
      409,
      "ask_closed",
    );
    expect((await call(asker, "GET", chat + "deliveries")).body).toMatchObject({
      items: [{ reason: "ask_result" }],
    });
  });
  it("limits automatic decisions to permitted sources and honors pause", async () => {
    const { asker, answerer, chat, from, to, newAsk } = await sharedAskThread();
    const settings = (await call(answerer, "GET", chat + "me/settings")).body as {
      agentAsks: object;
    };
    for (const source of [{ agent: from.id }, { role: { id: "staff", name: "Staff" } }]) {
      expectError(
        await call(answerer, "PUT", chat + "me/settings", {
          ...settings,
          agentAsks: { ...settings.agentAsks, auto: [{ from: source, kinds: ["handoff"] }] },
        }),
        403,
        "auto_accept_scope",
      );
    }
    const allow = {
      ...settings,
      agentAsks: {
        ...settings.agentAsks,
        auto: [{ from: { agent: from.id }, kinds: ["question"] }],
      },
    };
    expect((await call(answerer, "PUT", chat + "me/settings", allow)).status).toBe(200);
    expect((await call(asker, "POST", chat + "asks", newAsk)).body).toMatchObject({
      state: "open",
    });
    expect(
      (await call(answerer, "PUT", chat + "me/settings", { ...allow, agentsPaused: true })).status,
    ).toBe(200);
    expectError(
      await call(asker, "POST", chat + "asks", { ...newAsk, key: "paused" }),
      403,
      "agent_ask_paused",
    );
    expect((await call(answerer, "GET", chat + "handles")).body).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ id: to.id, paused: true })]),
    });
  });
  it("checks the named hand-off rule again on the receiver machine and leaves a stalled take actionable", async () => {
    const { asker, answerer, chat, from, to, threadRootId } = await sharedAskThread();
    const taskId = "task_" + randomText(5);
    const seed = (holder?: string) =>
      client.control("/board/seed", {
        tasks: [
          {
            id: taskId,
            title: "Hand-off",
            projectKey: "example-org/example-app",
            ...(holder && { holder }),
          },
        ],
      });
    await seed(asker.login);
    const settings = (await call(answerer, "GET", chat + "me/settings")).body as {
      agentAsks: object;
    };
    const rule = (allow: boolean) =>
      call(answerer, "PUT", chat + "me/settings", {
        ...settings,
        agentAsks: {
          ...settings.agentAsks,
          auto: allow ? [{ from: { person: from.owner }, kinds: ["handoff"] }] : [],
        },
      });
    await rule(true);
    const offer = await call(asker, "POST", chat + "handoffs", {
      taskId,
      to: to.owner,
      threadRootId,
      note: { goal: "Tests", done: "Unit", next: "Browser" },
      key: "offer",
    });
    expect(offer.body).toMatchObject({ state: "offered" });
    const id = (offer.body as { id: string }).id;
    const accept = () =>
      call(answerer, "POST", chat + "handoffs/" + id + "/accept", {
        byRule: true,
        machineId: answerer.machineId,
      });
    await rule(false);
    expectError(await accept(), 403, "auto_accept_scope");
    expect((await call(answerer, "GET", chat + "handoffs")).body).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ id, state: "offered" })]),
    });
    await rule(true);
    expect((await accept()).body).toMatchObject({
      state: "accepted",
      step: "waiting_release",
      byRule: true,
      machineId: answerer.machineId,
    });
    expect(
      JSON.stringify((await call(answerer, "GET", chat + "threads/" + threadRootId)).body),
    ).toContain("Auto-accepted by " + answerer.login + "'s rule.");
    await seed();
    const offers = () => call(answerer, "GET", chat + "handoffs");
    expect((await offers()).body).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id, state: "accepted", step: "waiting_take" }),
      ]),
    });
    if (!external)
      await expect
        .poll(async () => (await call(answerer, "GET", "/relay/v1/needs")).body, { timeout: 5000 })
        .toMatchObject({
          items: expect.arrayContaining([
            expect.objectContaining({
              kind: "handoff_stalled",
              handoffId: id,
              step: "waiting_take",
            }),
          ]),
        });
    const third = await enrol();
    await seed(third.login);
    expect((await offers()).body).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id, state: "closed", outcome: "lost", byRule: true }),
      ]),
    });
  });

  it("binds reviews to the PR head through acceptance, answer, head move and closure", async () => {
    const { asker, answerer, chat, to, newAsk } = await sharedAskThread();
    const repo = "example-org/example-app",
      headSha = "a".repeat(40),
      id = "task_" + randomText(5);
    const seed = (head: string, state = "open") =>
      client.control("/board/seed", {
        tasks: [
          {
            id,
            title: "Review",
            projectKey: repo,
            holder: asker.login,
            prs: [{ number: 17, author: asker.login, state, headSha: head }],
          },
        ],
      });
    const request = async (key: string, head: string) => {
      const r = await call(asker, "POST", chat + "asks", {
        ...newAsk,
        question: key,
        key,
        kind: "review",
        pr: { repo, number: 17, headSha: head },
      });
      return r.body as { id: string; state: string };
    };
    await seed(headSha);
    const first = await request("first_review", headSha);
    expect(first.state).toBe("waiting_owner");
    const path = chat + "asks/" + first.id;
    expect(
      (await call(answerer, "POST", path + "/decision", { allow: "always", kinds: ["review"] }))
        .body,
    ).toMatchObject({ state: "open" });
    expect(
      (
        await call(answerer, "POST", path + "/answer", {
          asHandle: to.id,
          text: "Checked retry. UI unchecked.",
          verdict: "clean",
          headSha,
        })
      ).body,
    ).toMatchObject({ state: "answered", answer: { verdict: "clean", headSha } });
    const second = await request("second_review", headSha);
    expect(second.state).toBe("open");
    const nextHead = "b".repeat(40);
    await seed(nextHead);
    const rows = () => call(answerer, "GET", chat + "asks?role=answerer");
    expect((await rows()).body).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id: second.id, state: "unanswered", reason: "head_moved" }),
        expect.objectContaining({ id: first.id, state: "answered" }),
      ]),
    });
    const last = await request("last_review", nextHead);
    await seed(nextHead, "closed");
    expect((await rows()).body).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ id: last.id, state: "orphaned" })]),
    });
  });
  it("keeps the reviewer independent and derives hand-off progress from the task holder", async () => {
    const { asker, answerer, chat, to, newAsk } = await sharedAskThread();
    const taskId = "task_" + randomText(5),
      repo = "example-org/example-app";
    await client.control("/board/seed", {
      tasks: [
        {
          id: taskId,
          title: "Review",
          projectKey: repo,
          holder: asker.login,
          prs: [{ number: 17, author: answerer.login, state: "open" }],
        },
      ],
    });
    expectError(
      await call(asker, "POST", chat + "asks", {
        ...newAsk,
        key: "review",
        kind: "review",
        pr: { repo, number: 17, headSha: "abc1234" },
      }),
      403,
      "review_same_owner",
    );
    const offer = await call(asker, "POST", chat + "handoffs", {
      taskId,
      to: to.owner,
      note: { goal: "Release", done: "Built", next: "Review" },
      key: "offer",
    });
    expect(offer.body).toMatchObject({ state: "offered" });
    const offerPath = chat + "handoffs/" + (offer.body as { id: string }).id;
    expect(
      (await call(answerer, "POST", offerPath + "/accept", { machineId: answerer.machineId })).body,
    ).toMatchObject({ state: "accepted", step: "waiting_release" });
    expect(
      (await call(asker, "POST", offerPath + "/withdraw", { reason: "Still working" })).body,
    ).toMatchObject({ state: "withdrawn" });
    expectError(await call(answerer, "POST", offerPath + "/accept", {}), 409, "handoff_closed");
    const next = await call(asker, "POST", chat + "handoffs", {
      taskId,
      to: to.owner,
      note: { goal: "Release", done: "Built", next: "Review" },
      key: "next",
    });
    const id = (next.body as { id: string }).id;
    await call(answerer, "POST", chat + "handoffs/" + id + "/accept", {});
    for (const holder of [null, answerer.login]) {
      await client.control("/board/seed", {
        tasks: [{ id: taskId, title: "Review", ...(holder && { holder }) }],
      });
      const offers = await call(answerer, "GET", chat + "handoffs?role=receiver");
      expect(offers.body).toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining(
            holder
              ? { id, state: "closed", outcome: "done" }
              : { id, state: "accepted", step: "waiting_take" },
          ),
        ]),
      });
    }
  });

  it("delivers a non-owner agent DM only to its machine and coalesces progress", async () => {
    const owner = await enrol(),
      sender = await enrol();
    const prefix = "/relay/v1/chat/",
      asHandle = "h_" + randomText(8);
    const handle = await call(owner, "PUT", prefix + "handles/" + asHandle, {
      threadRef: "thread1",
      name: "builder",
      provider: "codex",
      machineId: owner.machineId,
    });
    expectSchema("ChatHandle", handle.body);
    const dm = await call(sender, "POST", prefix + "conversations", {
      kind: "dm",
      members: [asHandle],
    });
    const conversationId = (dm.body as { id: string }).id;
    await call(sender, "POST", prefix + "messages", {
      conversationId,
      text: "What passed?",
      key: "question",
    });
    const items = (await call(owner, "GET", prefix + "deliveries")).body as {
      items: { id: string }[];
    };
    expect(items.items).toMatchObject([{ fromOwner: false, reason: "dm" }]);
    const path = prefix + "deliveries/" + items.items[0]!.id;
    expect((await call(sender, "POST", path + "/claim", { asHandle })).status).toBe(403);
    expect((await call(owner, "POST", path + "/claim", { asHandle })).body).toMatchObject({
      state: "claimed",
    });
    expect((await call(owner, "POST", path + "/consume", { asHandle })).body).toMatchObject({
      state: "consumed",
    });
    const progress = (text: string) =>
      call(owner, "PUT", prefix + "messages/" + conversationId + "/progress", {
        asHandle,
        text,
        state: "working",
      });
    const first = await progress("Checking");
    expectSchema("ChatMessage", first.body);
    expect((await progress("Reading results")).body).toMatchObject({
      id: (first.body as { id: string }).id,
      text: "Reading results",
    });
  });
  it("limits owner DM reads, delivers only explicitly mentioned agents, and resolves a named ask", async () => {
    const owner = await enrol(),
      colleague = await enrol();
    const path = "/relay/v1/chat/",
      h = "h_" + randomText(8),
      helper = "h_" + randomText(8);
    const who = async (machine: Enrolled) =>
      ((await call(machine, "GET", "/relay/v1/capabilities")).body as { me: { id: string } }).me.id;
    const person = await who(colleague);
    for (const [id, name] of [
      [h, "builder"],
      [helper, "reviewer"],
    ] as const) {
      expect(
        (
          await call(owner, "PUT", path + "handles/" + id, {
            name,
            threadRef: id,
            provider: "codex",
            machineId: owner.machineId,
          })
        ).status,
      ).toBe(200);
    }
    const dm = (
      await call(owner, "POST", path + "conversations", { kind: "dm", members: [person] })
    ).body as { id: string };
    const read = () =>
      call(owner, "GET", path + "conversations/" + dm.id + "/messages?asHandle=" + h);
    const privateText = "private" + randomText(6);
    await call(owner, "POST", path + "messages", {
      conversationId: dm.id,
      key: privateText,
      text: privateText,
    });
    const searchDm = () => call(owner, "GET", path + "search?q=" + privateText + "&asHandle=" + h);
    expect((await searchDm()).body).toMatchObject({ items: [] });
    expect((await read()).status).toBe(404);
    for (const enabled of [true, false]) {
      await call(owner, "PUT", path + "me/settings", {
        agentAsks: { default: "approve", auto: [], maxTokens: 200000, maxSeconds: 900 },
        agentsPaused: false,
        agentsReadMyDms: enabled,
        agentWakeDefault: "everyone",
      });
      expect((await searchDm()).body).toMatchObject({
        items: enabled ? [{ conversationId: dm.id }] : [],
      });
      expect((await read()).status).toBe(enabled ? 200 : 404);
    }
    const c = (
      await call(colleague, "POST", path + "conversations", {
        kind: "channel",
        name: "agents-" + randomText(6),
        template: "team",
        agents: "allowed",
      })
    ).body as { id: string };
    const ownerId = (
      (await call(owner, "GET", "/relay/v1/capabilities")).body as { me: { id: string } }
    ).me.id;
    await call(owner, "PUT", path + "conversations/" + c.id + "/members/" + ownerId);
    const root = (
      await call(colleague, "POST", path + "messages", {
        conversationId: c.id,
        text: "@" + owner.login + "/builder what passed?",
        key: "question",
      })
    ).body as { id: string };
    const write = (text: string, key: string) =>
      call(owner, "POST", path + "messages", {
        conversationId: c.id,
        threadRootId: root.id,
        text,
        key,
        asHandle: helper,
      });
    await write("Checks passed.", "reply");
    const inbox = () => call(owner, "GET", path + "deliveries?asHandle=" + h);
    expect((await inbox()).body).toMatchObject({
      items: [{ reason: "mention", fromOwner: false }],
    });
    await write("@" + owner.login + "/builder which test?", "mention");
    expect((await inbox()).body).toMatchObject({
      items: [{ reason: "mention" }, { reason: "mention", fromOwner: false }],
    });
    const ask = await call(owner, "POST", path + "asks", {
      to: { kind: "person", person },
      question: "Which upload?",
      key: "ask",
      asHandle: h,
      threadRootId: root.id,
    });
    expectSchema("ChatAsk", ask.body);
    const q = encodeURIComponent("upload kind:ask is:agent from:" + owner.login + "/builder");
    expect((await call(colleague, "GET", path + "search?q=" + q)).body).toMatchObject({
      items: [{ conversationId: c.id, threadRootId: root.id }],
    });
    expect(
      (await call(owner, "POST", path + "messages/" + root.id + "/promote?asHandle=" + h)).status,
    ).toBe(403);
    expect(
      (await call(owner, "POST", path + "messages/" + root.id + "/promote", { asHandle: h }))
        .status,
    ).toBe(403);
    expect((await call(colleague, "GET", "/relay/v1/needs")).body).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ kind: "chat_ask", ask: ask.body })]),
    });
    for (const answer of [{ choice: "Linux" }, { text: "A custom answer" }]) {
      const extra = await call(owner, "POST", path + "asks", {
        to: { kind: "person", person },
        question: "Choose a build",
        choices: ["Linux", "Mac"],
        key: randomText(8),
        asHandle: h,
        threadRootId: root.id,
      });
      const answerPath = path + "asks/" + (extra.body as { id: string }).id + "/answer";
      expect((await call(owner, "POST", answerPath, answer)).status).toBe(403);
      expect((await call(colleague, "POST", answerPath, { choice: "Unknown" })).status).toBe(400);
      const result = await call(colleague, "POST", answerPath, answer);
      expectSchema("ChatAsk", result.body);
      expect(result.body).toMatchObject({ state: "answered" });
      expect((await call(colleague, "POST", answerPath, answer)).status).toBe(409);
      expect((await inbox()).body).toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({
            reason: "answer",
            message: expect.objectContaining({ text: answer.choice ?? answer.text }),
          }),
        ]),
      });
    }
    await call(colleague, "POST", path + "messages", {
      conversationId: c.id,
      threadRootId: root.id,
      text: "Linux.",
      key: "answer",
    });
    expect((await inbox()).body).toMatchObject({
      items: [
        { reason: "mention" },
        { reason: "mention" },
        { reason: "answer" },
        { reason: "answer" },
        { reason: "answer" },
      ],
    });
  });
  it("opens one discussion per task and echoes lease transitions only while linked", async () => {
    const member = await enrol();
    const taskId = "t_" + randomText(6);
    const path = "/relay/v1/chat/";
    await client.control("/board/seed", {
      tasks: [{ id: taskId, title: "Build upload", comments: [], assignees: [], labels: [] }],
    });
    const open = () => call(member, "PUT", path + "tasks/" + taskId + "/thread");
    const location = await open();
    expectSchema("ChatThreadLocation", location.body);
    expect((await open()).body).toEqual(location.body);
    const { conversationId, threadRootId } = location.body as {
      conversationId: string;
      threadRootId: string;
    };
    const caps = await call(member, "GET", "/relay/v1/capabilities");
    const personId = (caps.body as { me: { id: string } }).me.id;
    expect(
      (await call(member, "PUT", path + "conversations/" + conversationId + "/members/" + personId))
        .status,
    ).toBe(200);
    const other = await call(member, "POST", path + "messages", {
      conversationId,
      text: "Another root",
      key: randomText(6),
    });
    const otherLink = path + "threads/" + (other.body as { id: string }).id + "/task";
    expect((await call(member, "PUT", otherLink, { taskRef: taskId })).body).toEqual(location.body);
    const tracker = (body: string, held: boolean) =>
      client.control("/board/tracker", {
        taskId,
        comments: [{ author: member.login, body }],
        assignees: held ? [member.login] : [],
        labels: held ? ["claimed"] : [],
      });
    for (const reason of ["done", "handing_over"]) {
      await tracker("claim: " + member.login + "/hub", true);
      await tracker("release: " + reason, false);
    }
    const thread = path + "threads/" + threadRootId;
    expect((await call(member, "GET", thread)).body).toMatchObject({
      items: [
        { kind: "system", systemEvent: "lease_taken" },
        { systemEvent: "lease_released", text: expect.stringContaining("done") },
        { systemEvent: "lease_taken" },
        { systemEvent: "lease_handed_over" },
      ],
    });
    const text = "needle" + randomText(6);
    const reply = await call(member, "POST", path + "messages", {
      conversationId,
      threadRootId,
      text,
      key: text,
    });
    const msg = (reply.body as { id: string }).id;
    const search = async (filter: string) => {
      const page = await call(
        member,
        "GET",
        path + "search?q=" + encodeURIComponent(text + " " + filter),
      );
      expectSchema("ChatSearch", page.body);
      return (page.body as { items: unknown[] }).items;
    };
    for (const filter of [
      "in:#general",
      "from:@" + member.login,
      "is:human",
      "has:task",
      "task:#1",
      "after:2000-01-01",
      "before:2100-01-01",
    ]) {
      expect(await search(filter)).toMatchObject([
        {
          messageId: msg,
          conversationId,
          conversationName: "#general",
          threadRootId,
          author: { login: member.login },
          createdAt: expect.any(String),
        },
      ]);
    }
    for (const filter of [
      "kind:ask",
      "is:agent",
      "from:" + member.login + "/builder",
      "before:2000-01-01",
      "after:2100-01-01",
      "task:#99",
    ])
      expect(await search(filter)).toEqual([]);
    const promote = path + "messages/" + msg + "/promote";
    expect((await call(member, "POST", promote)).body).toEqual({
      text,
      link: "/channels/" + conversationId + "?thread=" + threadRootId + "&message=" + msg,
    });
    await call(member, "DELETE", path + "messages/" + msg);
    expect(await search("")).toEqual([]);
    expect((await call(member, "POST", promote)).status).toBe(404);
    expect((await call(member, "DELETE", thread + "/task")).status).toBe(204);
    expect((await call(member, "PUT", otherLink, { taskRef: taskId })).body).toEqual({
      conversationId,
      threadRootId: (other.body as { id: string }).id,
    });
  });
  it("opens the same private DM for either participant and resolves its inbox item on read", async () => {
    const sender = await enrol(),
      recipient = await enrol(),
      outsider = await enrol();
    const idOf = async (machine: Enrolled) =>
      ((await call(machine, "GET", "/relay/v1/capabilities")).body as { me: { id: string } }).me.id;
    const open = (caller: Enrolled, id: string) =>
      call(caller, "POST", "/relay/v1/chat/conversations", { kind: "dm", members: [id] });
    const dm = await open(sender, await idOf(recipient));
    expectSchema("ChatConversation", dm.body);
    const { id } = dm.body as { id: string };
    expect(dm.body).toMatchObject({ kind: "dm", private: true, agentReaders: [] });
    expect((await open(recipient, await idOf(sender))).body).toMatchObject({ id });
    const path = "/relay/v1/chat/conversations/" + id;
    expect((await call(outsider, "GET", path + "/messages")).status).toBe(404);
    const posted = await call(sender, "POST", "/relay/v1/chat/messages", {
      conversationId: id,
      key: randomText(5),
      text: "Ready to review",
    });
    const m = posted.body as { seq: number; id: string };
    const read = { conversationId: id, seq: m.seq };
    expect((await call(recipient, "GET", "/relay/v1/needs")).body).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id: m.id, kind: "agent_message", chatRead: read }),
      ]),
    });
    await call(recipient, "POST", "/relay/v1/chat/read", read);
    expect((await call(recipient, "GET", "/relay/v1/needs")).body).toMatchObject({
      items: expect.not.arrayContaining([expect.objectContaining({ id: m.id })]),
    });
  });
  it("delivers a mention alert only to the mentioned person's machines", async () => {
    const sender = await enrol(),
      second = await enrol({ login: sender.login }),
      recipient = await enrol();
    const id = (
      (
        await call(sender, "POST", "/relay/v1/chat/conversations", {
          kind: "channel",
          name: "f2-" + randomText(4),
          template: "team",
          agents: "off",
        })
      ).body as { id: string }
    ).id;
    const path = "/relay/v1/chat/conversations/" + id;
    const person = (
      (await call(recipient, "GET", "/relay/v1/capabilities")).body as { me: { id: string } }
    ).me;
    await call(recipient, "PUT", path + "/members/" + person.id);
    const settings = { notify: "mentions", muted: false };
    expect((await call(recipient, "PUT", path + "/settings", settings)).body).toEqual(settings);
    const theirs = await openEvents(recipient),
      mine = await openEvents(second);
    try {
      const text = "@" + recipient.login + " please review";
      await call(sender, "POST", "/relay/v1/chat/messages", {
        conversationId: id,
        key: randomText(5),
        text,
      });
      expect((await nextEvent(theirs)).data).toMatchObject({
        notice: { author: sender.login, text },
      });
      expect((await nextEvent(mine)).data).not.toHaveProperty("notice");
    } finally {
      await theirs.cancel();
      await mine.cancel();
    }
  });
  it("creates a channel, syncs edits, and keeps each person's read position private", async () => {
    const owner = await enrol();
    const listing = await call(owner, "GET", "/relay/v1/chat/conversations");
    expect(listing.body).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({
          name: "general",
          defaultChannel: true,
          me: expect.objectContaining({ member: true }),
        }),
      ]),
    });
    const otherMachine = await enrol({ login: owner.login });
    const outsider = await enrol();
    const path = "/relay/v1/chat";
    const create = await call(owner, "POST", path + "/conversations", {
      kind: "channel",
      name: "test-" + randomText(5),
      template: "private",
      agents: "off",
    });
    expectSchema("ChatConversation", create.body);
    const { id } = create.body as { id: string };
    const post = { conversationId: id, key: randomText(8), text: "First message" };
    const stream = await openEvents(otherMachine);
    const root = await call(owner, "POST", path + "/messages", post);
    try {
      expect(await nextEvent(stream)).toMatchObject({
        event: "chat.changed",
        data: { change: { kind: "message.created", message: root.body } },
      });
    } finally {
      await stream.cancel();
    }
    expectSchema("ChatMessage", root.body);
    const message = root.body as { id: string; seq: number };
    const members = await call(owner, "GET", path + "/conversations/" + id + "/members");
    expectSchema("ChatMembers", members.body);
    const self = (members.body as { items: { id: string }[] }).items[0]!.id;
    expect(
      (await call(owner, "PUT", path + "/conversations/" + id + "/members/" + self)).status,
    ).toBe(200);
    expect((await call(owner, "DELETE", path + "/threads/" + message.id + "/follow")).status).toBe(
      204,
    );
    expect((await call(owner, "PUT", path + "/threads/" + message.id + "/follow")).status).toBe(
      204,
    );
    const caps = await call(owner, "GET", "/relay/v1/capabilities");
    if (
      (caps.body as { sections: { kind: string; flags: string[] }[] }).sections
        .find((s) => s.kind === "chat")
        ?.flags.includes("reactions")
    ) {
      const reactionPath =
        path + "/messages/" + message.id + "/reactions/" + encodeURIComponent("👍");
      expect((await call(owner, "PUT", reactionPath)).body).toMatchObject({
        reactions: [{ emoji: "👍", count: 1, mine: true }],
      });
      expect((await call(otherMachine, "DELETE", reactionPath)).body).toMatchObject({
        reactions: [],
      });
    }
    expect((await call(owner, "POST", path + "/messages", post)).body).toEqual(root.body);
    const reply = await call(owner, "POST", path + "/messages", {
      ...post,
      key: randomText(8),
      threadRootId: message.id,
      text: "Reply",
    });
    expect((await call(owner, "GET", path + "/threads/" + message.id)).body).toMatchObject({
      root: { replyCount: 1 },
      items: [{ text: "Reply" }],
    });
    await call(owner, "DELETE", path + "/messages/" + (reply.body as { id: string }).id);
    const after = await call(owner, "GET", path + "/threads/" + message.id);
    expect(after.body).toMatchObject({ root: { replyCount: 0 }, items: [{ deleted: true }] });
    expect((after.body as { root: unknown }).root).not.toHaveProperty("lastReplyAt");
    expect(
      (await call(owner, "PATCH", path + "/messages/" + message.id, { text: "Edited" })).body,
    ).toMatchObject({ text: "Edited" });
    expect(
      (await call(owner, "POST", path + "/read", { conversationId: id, seq: message.seq })).body,
    ).toEqual({ conversationId: id, seq: message.seq });
    expect((await call(otherMachine, "GET", path + "/conversations")).body).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id, me: expect.objectContaining({ readSeq: message.seq }) }),
      ]),
    });
    expect((await call(owner, "DELETE", path + "/messages/" + message.id)).body).toMatchObject({
      deleted: true,
      text: "",
    });
    expect(
      (await call(owner, "GET", path + "/conversations/" + id + "/messages")).body,
    ).toMatchObject({ items: [{ id: message.id, deleted: true }] });
    const feed = await call(owner, "GET", path + "/changes?after=" + message.seq);
    expectSchema("ChatChanges", feed.body);
    expect(JSON.stringify(feed.body)).not.toContain("Edited");
    expect(feed.body).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ kind: "read.moved" }),
        expect.objectContaining({ kind: "message.deleted" }),
      ]),
    });
    expect((await call(outsider, "GET", path + "/threads/" + message.id)).status).not.toBe(200);
    expect(
      JSON.stringify((await call(outsider, "GET", path + "/changes?after=" + message.seq)).body),
    ).not.toContain(message.id);
  });
});

describe("shared machines", () => {
  it("binds host facts and sandbox offers to host credentials and serves quota only to its owner", async () => {
    const owner = await enrol({ poolHostId: "dev" });
    const colleague = await enrol({ role: "staff" });
    expect((await call(owner, "GET", "/relay/v1/machines")).body).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id: owner.machineId, poolHostId: "dev" }),
      ]),
    });
    const prefix = "/relay/v1/pool";
    const hub = (method: string, path: string, body?: unknown) =>
      call(owner, method, prefix + path, body);
    const capabilities = (await call(owner, "GET", "/relay/v1/capabilities")).body as {
      me: { id: string };
      sections: { kind: string }[];
    };
    expect(capabilities.sections.some((s) => s.kind === "pool")).toBe(true);
    const facts = readExample("pool-facts.json") as PoolHostFacts;
    const hostId = facts.limits.id;
    const key = generateMachineKey();
    const hostEnroll = (action: string, body: unknown) =>
      client.send(key, "POST", prefix + "/hosts/enroll/" + action, { body });
    const started = await hostEnroll("start", {
      machine: machineFacts(hostId),
      publicKey: key.publicKey,
    });
    expectSchema("EnrolStartResponse", started.body);
    const pairing = started.body as { pairingId: string; confirmCode: string };
    const pollHost = () => hostEnroll("poll", { pairingId: pairing.pairingId });
    expect((await pollHost()).body).toMatchObject({ state: "pending" });
    const admin = (body?: unknown) => hub(body ? "POST" : "GET", "/founder", body);
    expectError(await call(colleague, "GET", prefix + "/founder"), 403, "forbidden");
    expectError(
      await call(colleague, "POST", prefix + "/founder", {
        action: "refuse",
        pairingId: pairing.pairingId,
      }),
      403,
      "forbidden",
    );
    const founderListing = (await admin()).body;
    expectSchema("PoolFounderView", founderListing);
    expect(founderListing).toMatchObject({
      enrolments: expect.arrayContaining([{ hostId, pairingId: pairing.pairingId }]),
    });
    const unwanted = await hostEnroll("start", {
      machine: machineFacts(hostId),
      publicKey: key.publicKey,
    });
    const refusedId = (unwanted.body as { pairingId: string }).pairingId;
    expect((await admin({ action: "refuse", pairingId: refusedId })).status).toBe(200);
    expect((await hostEnroll("poll", { pairingId: refusedId })).body).toMatchObject({
      state: "refused",
    });
    expect(
      (await admin({ action: "confirm", pairingId: pairing.pairingId, code: pairing.confirmCode }))
        .status,
    ).toBe(200);
    const approved = (await pollHost()).body as { token: string; machineId: string };
    const hostCall = (path: string, body: unknown) =>
      client.send(key, "POST", prefix + path, {
        device: approved.machineId,
        token: approved.token,
        body,
      });
    const rows = facts.workspaces.map((w) => ({ ...w, personId: capabilities.me.id }));
    expectError(await hub("POST", "/hosts/facts", facts), 403, "forbidden");
    expectError(
      await hostCall("/hosts/facts", readExample("invalid/pool-facts-memory.json")),
      400,
      "malformed",
    );
    const timestampedRows = rows.map((row) => ({
      ...row,
      resources: { ...row.resources, measuredAt: "2026-11-27T12:00:00Z" },
    }));
    expectError(
      await hostCall("/hosts/facts", { ...facts, workspaces: timestampedRows }),
      400,
      "malformed",
    );
    const policy = await hostCall("/hosts/facts", {
      ...facts,
      workspaces: rows,
      limits: { ...facts.limits, sandbox_slots: { small: 1, large: 8 } },
    });
    expect(policy.status).toBe(200);
    expectSchema("PoolPolicy", policy.body);
    expect(policy.body).toMatchObject({ limits: { sandbox_slots: { small: 1, large: 1 } } });
    const mine = await hub("GET", "");
    expectSchema("PoolView", mine.body);
    expect((mine.body as PoolView).me.workspaces[0]?.resources).toEqual(rows[0]?.resources);
    const theirs = (await call(colleague, "GET", prefix)).body as PoolView;
    expect(theirs.hosts).toEqual((mine.body as PoolView).hosts);
    expect(theirs.me.workspaces).toEqual([]);
    expect((await call(colleague, "POST", prefix + "/workspaces", { hostId })).body).toEqual({
      hostId,
      state: "asked",
    });
    const requested = (await call(colleague, "GET", prefix)).body as PoolView;
    expect(requested.me.workspaces).toEqual([{ hostId, state: "asked", resources: null }]);
    expect((await hub("GET", "")).body).toEqual(mine.body);
    const founderNeeds = await call(owner, "GET", "/relay/v1/needs");
    expect(founderNeeds.body).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ kind: "workspace_request" })]),
    });
    const founderView = (await admin()).body as PoolFounderView;
    const ceiling = {
      sizes: facts.sizes,
      limits: { ...facts.limits, sandbox_slots: { small: 1, large: 1 } },
    };
    expectError(
      await admin({
        action: "limits",
        requested: {
          ...ceiling,
          limits: { ...ceiling.limits, sandbox_slots: { small: 2, large: 1 } },
        },
      }),
      409,
      "pool_limit_reached",
    );
    expect((await admin({ action: "limits", requested: ceiling })).body).toMatchObject({
      hosts: expect.arrayContaining([
        expect.objectContaining({ requested: ceiling, effective: ceiling }),
      ]),
    });
    const approval = { action: "approve", requestId: founderView.requests[0]!.requestId };
    expect((await admin(approval)).status).toBe(200);
    expect((await admin(approval)).status).toBe(200);
    expect((await call(colleague, "POST", prefix + "/workspaces", { hostId })).body).toEqual({
      hostId,
      state: "approved",
    });
    const request = { hostId, size: "small", image: "sha256:" + "a".repeat(64) };
    const created = await hub("POST", "/sandboxes", request);
    expectSchema("PoolSandbox", created.body);
    const id = (created.body as PoolSandbox).id;
    const path = "/sandboxes/" + id;
    expectError(await call(colleague, "GET", prefix + path), 404, "not_found");
    expect((await hub("GET", path)).body).toMatchObject({ place: 1, state: "waiting" });
    const offered = await hostCall("/hosts/next", { size: "small" });
    expectSchema("PoolNextResponse", offered.body);
    const offer = (offered.body as PoolNextResponse).offer!;
    expect(offer.id).toBe(id);
    expect(Buffer.from(offer.bodyBase64, "base64").toString()).toBe(JSON.stringify(request));
    expect(offer.publicKey).toBe(owner.key.publicKey);
    const signer = publicKeyFromBase64(offer.publicKey);
    expect(
      signer &&
        verify(
          signer,
          {
            method: "POST",
            target: prefix + "/sandboxes",
            device: offer.machineId,
            counter: offer.counter,
            sentAt: offer.sentAt,
            body: Buffer.from(offer.bodyBase64, "base64"),
          },
          offer.signature,
        ),
    ).toBe(true);
    await client.control("/pool/offer/expire", { sandboxId: id });
    const late = await hostCall(path + "/state", {
      state: "starting",
      offerId: offer.offerId,
      machineId: null,
      reason: null,
    });
    expectError(late, 409, "stale_offer");
    expectSchema("PoolStateRefusal", late.body);
    expect((late.body as { current: unknown }).current).toEqual({
      sandboxId: id,
      state: "waiting",
    });
    const renewed = await hostCall("/hosts/next", { size: "small" });
    expectSchema("PoolNextResponse", renewed.body);
    const current = (renewed.body as PoolNextResponse).offer!;
    expect(current.id).toBe(id);
    expect(current.offerId).not.toBe(offer.offerId);
    const before = await hub("GET", path);
    const report = (state: string, offerId = current.offerId) =>
      hostCall(path + "/state", {
        offerId,
        state,
        machineId: state === "running" ? owner.machineId : null,
        reason: null,
      });
    expectError(await report("starting", offer.offerId), 409, "stale_offer");
    expect((await hub("GET", path)).body).toEqual(before.body);
    expect((await report("starting")).body).toMatchObject({ state: "starting" });
    const invalid = await report("ended");
    expectError(invalid, 403, "forbidden");
    expectSchema("PoolStateRefusal", invalid.body);
    expect(invalid.body).toMatchObject({
      current: { sandboxId: id, offerId: current.offerId, state: "starting" },
    });
    const running = (await report("running")).body as PoolSandbox;
    const extended = (await hub("POST", path + "/extend")).body as PoolSandbox;
    expect(Date.parse(extended.endsAt!) - Date.parse(running.endsAt!)).toBe(3600000);
    const next = () => hostCall("/hosts/next", { size: "small" });
    const booking = { sandboxId: id, offerId: current.offerId };
    const extend = { ...booking, action: "extend", endsAt: extended.endsAt };
    expect((await next()).body).toEqual({ offer: null, directives: [extend] });
    const heldFacts = {
      ...facts,
      contention: { ...facts.contention, freeSlots: { small: 1, large: 1 } },
    };
    expect((await hostCall("/hosts/facts", heldFacts)).body).toMatchObject({
      directives: [extend],
    });
    expect(JSON.stringify((await hub("GET", "")).body)).not.toContain(current.offerId);
    const acknowledge = (endsAt: string | null) =>
      hostCall(path + "/state", {
        offerId: current.offerId,
        state: "running",
        machineId: owner.machineId,
        reason: null,
        endsAt,
      });
    expectError(await acknowledge(running.endsAt), 403, "forbidden");
    expect((await next()).body).toMatchObject({ directives: [extend] });
    expect((await acknowledge(extended.endsAt)).body).toMatchObject({ endsAt: extended.endsAt });
    expect((await next()).body).toEqual({ offer: null, directives: [] });
    expect((await hub("DELETE", path)).body).toMatchObject({ state: "ending" });
    const cancel = { ...booking, action: "cancel" };
    expect((await next()).body).toMatchObject({ directives: [cancel] });
    expect((await hostCall("/hosts/facts", heldFacts)).body).toMatchObject({
      directives: [cancel],
    });
    expect((await report("ending")).body).toMatchObject({ state: "ending" });
    expect((await next()).body).toMatchObject({ directives: [] });
    await hostCall("/hosts/facts", heldFacts);
    const another = await call(colleague, "POST", prefix + "/sandboxes", request);
    expect((await next()).body).toEqual({ offer: null, directives: [] });
    expect(
      (await admin({ action: "limits", requested: { limits: facts.limits, sizes: facts.sizes } }))
        .status,
    ).toBe(200);
    const anotherId = (another.body as PoolSandbox).id;
    const unacknowledged = ((await next()).body as PoolNextResponse).offer!;
    expect(unacknowledged.id).toBe(anotherId);
    const third = await enrol();
    const queued = await call(third, "POST", prefix + "/sandboxes", request);
    expect(queued.body).toMatchObject({ state: "waiting" });
    expect((await next()).body).toEqual({ offer: null, directives: [] });
    const anotherPath = "/sandboxes/" + anotherId;
    const cancelled = await call(colleague, "DELETE", prefix + anotherPath);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ state: "ended", reason: "cancelled" });
    expect((await next()).body).toMatchObject({
      offer: { id: (queued.body as PoolSandbox).id },
      directives: [],
    });

    const lateStart = await hostCall(anotherPath + "/state", {
      offerId: unacknowledged.offerId,
      state: "starting",
      machineId: null,
      reason: null,
    });
    expectError(lateStart, 409, "stale_offer");
    expectSchema("PoolStateRefusal", lateStart.body);
    expect(lateStart.body).toMatchObject({ current: { sandboxId: anotherId, state: "ended" } });
    expect((await report("ended")).body).toMatchObject({ state: "ended" });
  });
});
