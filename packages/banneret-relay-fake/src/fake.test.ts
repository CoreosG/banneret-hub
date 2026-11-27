import { afterEach, describe, expect, it } from "vite-plus/test";

import { RelayClient } from "./client.ts";
import { type FakeRelay, parsePublicOrigin, startFakeRelay } from "./fake.ts";
import { generateMachineKey } from "./signing.ts";

const relays: FakeRelay[] = [];
afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.close()));
});

const startBrowserUrl = async (options: { publicOrigin?: string }): Promise<string> => {
  const relay = await startFakeRelay({ autoApprove: false, ...options });
  relays.push(relay);
  const key = generateMachineKey();
  const reply = await new RelayClient(relay.url).send(key, "POST", "/relay/v1/enroll/start", {
    body: {
      publicKey: key.publicKey,
      machine: {
        environmentId: "env_public_origin",
        label: "Public origin test",
        kind: "server",
        hostname: "test-host",
        os: "Ubuntu 24.04",
        hubVersion: "0.4.2",
        policyFingerprint: null,
        sandbox: { enabled: false, image: null },
      },
    },
  });
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  return (reply.body as { browserUrl: string }).browserUrl;
};

describe("fake relay publicOrigin", () => {
  it("returns a browserUrl on the public origin", async () => {
    const browserUrl = await startBrowserUrl({ publicOrigin: "https://hub.example.ts.net:8443" });
    expect(new URL(browserUrl).origin).toBe("https://hub.example.ts.net:8443");
    expect(browserUrl).toMatch(/^https:\/\/hub\.example\.ts\.net:8443\/enroll\?pairing=/);
  });

  it("keeps the Host header origin when unset", async () => {
    expect(await startBrowserUrl({})).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/enroll\?pairing=/);
  });

  it.each(["https://h.example:8443/path", "ftp://h", "h:8443", "https://h?x=1", "https://u@h", ""])(
    "refuses %j at start",
    async (value) => {
      expect(() => parsePublicOrigin(value)).toThrow(/publicOrigin/);
      await expect(startFakeRelay({ publicOrigin: value })).rejects.toThrow(/publicOrigin/);
    },
  );

  it("accepts http and https origins with or without a port", () => {
    expect(parsePublicOrigin("https://h.example")).toBe("https://h.example");
    expect(parsePublicOrigin("http://h:80")).toBe("http://h");
    expect(parsePublicOrigin("https://h:8443/")).toBe("https://h:8443");
  });
});

describe("relay configuration", () => {
  it("rejects non-HTTPS dashboards and lease expiry at or before stale", async () => {
    await expect(
      startFakeRelay({
        dashboards: [{ id: "bad", title: "Metrics", url: "http://metrics.example.org" }],
      }),
    ).rejects.toThrow("dashboard");
    await expect(
      startFakeRelay({ board: { staleSeconds: 60, expirySeconds: 60 } }),
    ).rejects.toThrow("lease clocks");
  });
});
