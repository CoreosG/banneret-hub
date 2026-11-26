// @effect-diagnostics nodeBuiltinImport:off - the expected digests are computed independently.
import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "@effect/vitest";

import { projectKeyFromRemote } from "./projectKey.ts";
import {
  RelayCounter,
  keyFromSeed,
  sign,
  signingInput,
  waitBeforeSigning,
} from "./RelaySigning.ts";

const SEED = Uint8Array.from({ length: 32 }, (_, index) => index);
const encoder = new TextEncoder();

// docs/banneret/relay-v1/README.md, "Test vectors".
describe("relay signing", () => {
  const key = keyFromSeed(SEED);

  it("derives the README's public key from seed 00..1f", () => {
    expect(key.publicKey).toBe("A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=");
  });

  it("signs the enrolment poll vector", () => {
    const parts = {
      method: "POST",
      target: "/relay/v1/enroll/poll",
      device: "",
      counter: "0",
      sentAt: "2026-11-26T10:00:00Z",
      body: encoder.encode('{"pairingId":"pr_Zk3mN8vQ"}'),
    };
    expect(Buffer.from(signingInput(parts)).toString("utf8")).toBe(
      'relay/v1\nPOST\n/relay/v1/enroll/poll\n\n0\n2026-11-26T10:00:00Z\n{"pairingId":"pr_Zk3mN8vQ"}',
    );
    expect(sign(key, parts)).toBe(
      "rPCodAbBYNrjUCPlH1wWSIwomRnNdT9uQ5PNpAcVBOasEIMXT8gqBrcgHLeYoQQoHvxuaZjRbjBq6GTICT67Dw==",
    );
  });

  it("signs the device GET vector with a query", () => {
    expect(
      sign(key, {
        method: "GET",
        target: "/relay/v1/needs?cursor=c_eyJvIjoyfQ&limit=20",
        device: "m_4fT9wQ",
        counter: "1795687200000003",
        sentAt: "2026-11-26T10:00:00Z",
        body: new Uint8Array(),
      }),
    ).toBe(
      "RdNPpOkxOTulgldjylwLSDwD3VB04h1yN4PLAyFQkovxCBoDYMAlEXZbnVL62ko3sx/9yyr/eFcB68EzBUIHCQ==",
    );
  });
});

describe("relay counter", () => {
  it("is strictly increasing within a millisecond and across a backward clock step", () => {
    let now = 1_000;
    const counter = new RelayCounter(() => now);
    expect(counter.next()).toBe(1_000_000n);
    expect(counter.next()).toBe(1_000_001n);
    now = 900;
    expect(counter.next()).toBe(1_000_002n);
    now = 2_000;
    expect(counter.next()).toBe(2_000_000n);
  });

  it("continues above a saved mark", () => {
    const counter = new RelayCounter(() => 1_000, 5_000_000n);
    expect(counter.next()).toBe(5_000_001n);
  });

  it("waits out a saved mark ahead of the clock, and calls a long wait a wrong clock", () => {
    expect(waitBeforeSigning(2_000, 1_999_999n)).toBe(0);
    expect(waitBeforeSigning(2_000, 2_000_000n)).toBe(1);
    expect(waitBeforeSigning(2_000, 2_500_000n)).toBe(501);
    expect(waitBeforeSigning(2_000, BigInt(2_000 + 119_999) * 1000n)).toBe(120_000);
    expect(waitBeforeSigning(2_000, BigInt(2_000 + 120_000) * 1000n)).toBe("clock_wrong");
  });
});

describe("projectKeyFromRemote", () => {
  const expected = (identity: string) =>
    `sha256:${NodeCrypto.createHash("sha256").update(identity).digest("hex")}`;

  it.each([
    ["git@github.com:example-org/example-app.git"],
    ["ssh://git@github.com/example-org/example-app.git"],
    ["https://github.com/example-org/example-app"],
    ["https://github.com/example-org/example-app.git"],
    ["https://user:secret@github.com:443/example-org/example-app.git"],
    ["ssh://git@github.com:22/Example-Org/Example-App"],
    ["HTTPS://GITHUB.COM/EXAMPLE-ORG/EXAMPLE-APP/"],
  ])("keys %s as github.com/example-org/example-app", (remote) => {
    expect(projectKeyFromRemote(remote)).toBe(expected("github.com/example-org/example-app"));
  });

  it("never keys a local path", () => {
    expect(projectKeyFromRemote("/home/someone/src/example-app")).toBeNull();
    expect(projectKeyFromRemote("C:\\src\\example-app")).toBeNull();
    expect(projectKeyFromRemote("../example-app")).toBeNull();
  });
});
