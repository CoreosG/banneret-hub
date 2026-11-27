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
  readonly id: string;
  readonly connected: boolean;
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
  reset: "ResetEvent",
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

  describe("Today visits", () => {
    const visitState = async (machine: Enrolled) =>
      (await client.control("/visits/read", { login: machine.login })) as {
        lastVisitAt: string | null;
        lastReadAt: string | null;
      };
    const todayAt = async (machine: Enrolled, target: string) => {
      const reply = await call(machine, "GET", target);
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      expectSchema("Today", reply.body);
      return (reply.body as { lastVisitAt: string | null }).lastVisitAt;
    };

    it("leaves lastVisitAt alone on a read without visit=1", async () => {
      const machine = await enrol();
      expect(await todayAt(machine, "/relay/v1/today")).toBeNull();
      expect(await visitState(machine)).toEqual({ lastVisitAt: null, lastReadAt: null });
      await todayAt(machine, "/relay/v1/today?visit=1");
      const before = await visitState(machine);
      expect(before.lastReadAt).not.toBeNull();
      await client.control("/visits/age", { login: machine.login, minutes: 45 });
      const aged = await visitState(machine);
      expect(await todayAt(machine, "/relay/v1/today")).toBe(aged.lastVisitAt);
      expect(await visitState(machine)).toEqual(aged);
    });

    it("moves lastVisitAt on a read with visit=1 after a gap", async () => {
      const machine = await enrol();
      expect(await todayAt(machine, "/relay/v1/today?visit=1")).toBeNull();
      await client.control("/visits/age", { login: machine.login, minutes: 45 });
      const aged = await visitState(machine);
      expect(await todayAt(machine, "/relay/v1/today?visit=1")).toBe(aged.lastReadAt);
      const after = await visitState(machine);
      expect(after.lastVisitAt).toBe(aged.lastReadAt);
      expect(Date.parse(after.lastReadAt ?? "")).toBeGreaterThan(Date.parse(aged.lastReadAt ?? ""));
    });

    it("counts two visit reads less than 30 minutes apart as one visit", async () => {
      const machine = await enrol();
      await todayAt(machine, "/relay/v1/today?visit=1");
      await client.control("/visits/age", { login: machine.login, minutes: 45 });
      await todayAt(machine, "/relay/v1/today?visit=1");
      await client.control("/visits/age", { login: machine.login, minutes: 10 });
      const state = await visitState(machine);
      expect(await todayAt(machine, "/relay/v1/today?visit=1")).toBe(state.lastVisitAt);
      expect((await visitState(machine)).lastVisitAt).toBe(state.lastVisitAt);
    });

    it("refuses a visit value other than 1", async () => {
      const machine = await enrol();
      expectError(await call(machine, "GET", "/relay/v1/today?visit=2"), 400, "malformed");
    });
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

  it.each(["bad.id", "x".repeat(65)])(
    "answers not_found, never 400, for malformed id %s",
    async (id) => {
      const founder = await enrol();
      expectError(await call(founder, "DELETE", `/relay/v1/machines/${id}`), 404, "not_found");
    },
  );
});

describe("machine visibility", () => {
  it("shows every live machine to everyone, and a revoked one only to its owner and founders", async () => {
    const owner = await enrol({ role: "limited_staff" });
    const ownerOther = await enrol({ login: owner.login, role: "limited_staff" });
    const founderMachine = await enrol({ role: "founder" });
    const staff = await enrol({ role: "limited_staff" });

    const staffView = await listMachines(staff);
    for (const live of [owner, ownerOther, founderMachine]) {
      expect(staffView.find((item) => item.id === live.machineId)).toMatchObject({
        revocable: false,
      });
    }
    expect(staffView.find((item) => item.id === owner.machineId)?.revokedAt).toBeUndefined();

    expect((await call(owner, "DELETE", `/relay/v1/machines/${owner.machineId}`)).status).toBe(204);

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
    for (const kind of ["needs", "health", "work", "machines"]) {
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
    const listed = (await listMachines(machine)).map((item) => item.id);
    expect(
      (fetched.machines as { items: Array<{ id: string }> }).items.map((item) => item.id),
    ).toEqual(listed);
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
    const ownersHealth = bare(head.files.health ?? "");
    expect((await readFile(owner, ownersNeeds)).status).toBe(200);
    // `other` has a head of its own, which does not name the owner's needs file.
    await readHead(other);
    expectNotFound(await readFile(other, ownersNeeds));
    // `stranger` never read a head. The owner's health file may hold the very bytes `stranger` would get, and
    // it is still refused: sharing storage never grants access.
    expectNotFound(await readFile(stranger, ownersNeeds));
    expectNotFound(await readFile(stranger, ownersHealth));
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

  it("never moves lastVisitAt, and never counts as a visit", async () => {
    const machine = await enrol();
    const visitState = async () =>
      (await client.control("/visits/read", { login: machine.login })) as {
        lastVisitAt: string | null;
        lastReadAt: string | null;
      };
    const readAll = async () => {
      const { reply, head } = await readHead(machine);
      for (const ref of Object.values(head.files)) {
        expect((await readFile(machine, bare(ref))).status).toBe(200);
      }
      const etag = reply.headers.get("etag") ?? "";
      expect(
        (await callBytes(machine, "/relay/v1/snapshot/head", { "If-None-Match": etag })).status,
      ).toBe(304);
    };
    expect(await visitState()).toEqual({ lastVisitAt: null, lastReadAt: null });
    await readAll();
    expect(await visitState()).toEqual({ lastVisitAt: null, lastReadAt: null });
    const visit = await call(machine, "GET", "/relay/v1/today?visit=1");
    expect(visit.status).toBe(200);
    await client.control("/visits/age", { login: machine.login, minutes: 45 });
    const aged = await visitState();
    await readAll();
    expect(await visitState()).toEqual(aged);
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
    for (const key of ["needs", "health", "work", "machines"]) expect(files[key]).toBeDefined();
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
    expect(card?.prs).toEqual([
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
    const reply = await call(machine, "GET", "/relay/v1/today?visit=1");
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

  describe("checked", () => {
    const personIdOf = async (machine: Enrolled): Promise<string> => {
      const reply = await call(machine, "GET", "/relay/v1/capabilities");
      return (reply.body as { me: { id: string } }).me.id;
    };
    const checkedFor = async (by: Enrolled, reviewer: Enrolled) => {
      const machine = await enrol();
      const task = id();
      await seedTasks([{ id: task, title: "Built task" }]);
      await client.control("/checked/seed", {
        taskId: task,
        by: await personIdOf(by),
        reviewer: await personIdOf(reviewer),
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

    it("is valid when a sign-off role holder checks and someone else reviewed", async () => {
      const checker = await enrol({ role: "founder" });
      const reviewer = await enrol({ role: "limited_staff" });
      const { task, boardStatus } = await checkedFor(checker, reviewer);
      expect(task.checked?.valid).toBe(true);
      expect(task.checked?.by.login).toBe(checker.login);
      expect(task.checked?.by.id).toBe(await personIdOf(checker));
      expect(task.checked?.ignoredReason).toBeUndefined();
      expect(task.status).toBe("checked");
      expect(boardStatus).toBe("checked");
    });

    it("is invalid, with the reason, when the reviewer is the checker", async () => {
      const checker = await enrol({ role: "founder" });
      const { task, boardStatus } = await checkedFor(checker, checker);
      expect(task.checked?.valid).toBe(false);
      expect(task.checked?.ignoredReason).toMatch(/review/i);
      expect(task.status).not.toBe("checked");
      expect(boardStatus).not.toBe("checked");
    });

    it("is invalid, with the reason, when the checker lacks the sign-off role", async () => {
      const checker = await enrol({ role: "limited_staff" });
      const reviewer = await enrol({ role: "founder" });
      const { task, boardStatus } = await checkedFor(checker, reviewer);
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
