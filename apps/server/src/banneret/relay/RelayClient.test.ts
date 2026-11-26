// @effect-diagnostics globalFetch:off - the test counts calls to a stubbed global fetch.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { isRelayApiCall, relayFetch } from "./RelayClient.ts";
import { keyFromSeed } from "./RelaySigning.ts";

const ORIGIN = "https://banneret-dev.tail1a1d69.ts.net:10000";
const key = keyFromSeed(Uint8Array.from({ length: 32 }, (_, index) => index));

describe("isRelayApiCall", () => {
  it("accepts a bare origin and a /relay/v1/ target", () => {
    expect(isRelayApiCall(ORIGIN, "/relay/v1/enroll/poll")).toBe(true);
    expect(isRelayApiCall(ORIGIN, "/relay/v1/machines?limit=100&cursor=a%2Fb")).toBe(true);
  });

  it("refuses browser paths, path tricks and origins with a path", () => {
    for (const target of [
      "/admin/hub/enroll/pr_1",
      "/relay/v1",
      "/relay/v2/capabilities",
      "//relay/v1/capabilities",
      "/relay/v1//capabilities",
      "/relay/v1/../admin/hub/enroll",
      "/relay/v1/./capabilities",
      "/relay/v1\\..\\admin",
      "/relay/v1/capabilities#x",
    ]) {
      expect(isRelayApiCall(ORIGIN, target), target).toBe(false);
    }
    expect(isRelayApiCall(`${ORIGIN}/`, "/relay/v1/capabilities")).toBe(false);
    expect(isRelayApiCall(`${ORIGIN}/admin`, "/relay/v1/capabilities")).toBe(false);
  });
});

describe("relayFetch", () => {
  it.effect("never sends a signed request outside /relay/v1", () =>
    Effect.gen(function* () {
      const original = globalThis.fetch;
      let calls = 0;
      globalThis.fetch = (async () => {
        calls += 1;
        return new Response("{}", { status: 200 });
      }) as typeof fetch;
      try {
        const error = yield* relayFetch({
          origin: ORIGIN,
          method: "GET",
          target: "/admin/hub/enroll/pr_1",
          signer: { kind: "device", key, token: "t", machineId: "m_1", counter: 1n },
          nowMs: 0,
        }).pipe(Effect.flip);
        expect(error.code).toBe("not_relay_api");
        expect(error.retryable).toBe(false);
        expect(calls).toBe(0);
        // The same relay, unsigned and on the API path, is sent.
        yield* relayFetch({
          origin: ORIGIN,
          method: "GET",
          target: "/relay/v1/capabilities",
          nowMs: 0,
        });
        expect(calls).toBe(1);
      } finally {
        globalThis.fetch = original;
      }
    }),
  );
});
