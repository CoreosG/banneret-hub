// What counts as a person's own copy of a company server, and what is never touched.
import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";

import { markCompanyEntry, switchOffInClaude, switchOffInCodex } from "./ownCopies.ts";

const COMPANY = "https://mcp.acme.test/mcp";
const hub = (url = COMPANY) =>
  markCompanyEntry(
    { url: "http://127.0.0.1:3773/banneret/plugins/co-acme" },
    { threadId: ThreadId.make("thread"), sourceId: "acme", url },
  );

const codex = (own: object, config: Record<string, never | object> = {}) =>
  switchOffInCodex({ "mcp_servers.co-acme": hub(), ...config } as never, own);

describe("a Codex copy", () => {
  it.each([
    ["the same address", { url: COMPANY }],
    ["a trailing slash and a query", { url: COMPANY + "/?x=1" }],
    ["capitals and the default port", { url: "HTTPS://MCP.Acme.Test:443/mcp" }],
    ["a bridge command", { command: "npx", args: ["mcp-remote", COMPANY] }],
  ])("is found by %s", (_, server) => {
    const plan = codex({ mine: server });
    expect(plan.config["mcp_servers.mine.enabled"]).toBe(false);
    expect(plan.copies).toEqual([{ sourceId: "acme", off: true }]);
  });

  it.each([
    ["another path", { url: "https://mcp.acme.test/other" }],
    ["another port", { url: "https://mcp.acme.test:8443/mcp" }],
    ["another scheme", { url: "http://mcp.acme.test/mcp" }],
    ["a command without the address", { command: "acme-mcp", args: ["--stdio"] }],
    ["already off", { url: COMPANY, enabled: false }],
  ])("is not %s", (_, server) => {
    // The bare source id is no identity: a person's own server of that name stays on.
    const plan = codex({ acme: server });
    expect(Object.keys(plan.config)).toEqual(["mcp_servers.co-acme"]);
    expect(plan.copies).toEqual([]);
  });

  it("never switches off a server the Hub sets in the same launch", () => {
    const plan = codex(
      { "t3-code": { url: COMPANY }, "banneret-plugin-notes": { url: COMPANY } },
      { "mcp_servers.t3-code": {}, "mcp_servers.banneret-plugin-notes": {} },
    );
    // Theirs of a Hub name would merge into the Hub's server, which the T3 and plugin names rule out.
    expect(Object.keys(plan.config).filter((key) => key.endsWith(".enabled"))).toEqual([]);
  });

  it("gives the Hub's copy a name that neither side uses", () => {
    const plan = codex(
      { "co-acme": { command: "acme", enabled: false }, "co-acme-hub": { command: "other" } },
      { "mcp_servers.co-acme-hub-2": {} },
    );
    expect(Object.keys(plan.config).sort()).toEqual([
      "mcp_servers.co-acme-hub-2",
      "mcp_servers.co-acme-hub-3",
    ]);
    // Theirs was off already, so there is nothing to tell.
    expect(plan.copies).toEqual([]);
  });

  it.each(["acme.direct", "acme=direct"])(
    "reports %s as still on: an override key cannot name it",
    (name) => {
      const plan = codex({ [name]: { url: COMPANY }, mine: { url: COMPANY } });
      expect(Object.keys(plan.config)).toEqual(["mcp_servers.co-acme", "mcp_servers.mine.enabled"]);
      expect(plan.copies).toEqual([{ sourceId: "acme", off: false }]);
    },
  );

  it("leaves a chat without company servers as it was", () => {
    const config = { "mcp_servers.notes": { url: COMPANY } };
    expect(switchOffInCodex(config, { mine: { url: COMPANY } })).toEqual({ config, copies: [] });
  });
});

describe("a Claude copy", () => {
  const claude = (
    own: ReadonlyArray<readonly [string, unknown]>,
    settings?: string | object,
    url = COMPANY,
  ) =>
    switchOffInClaude(
      {
        ...(settings === undefined ? {} : { settings }),
        mcpServers: { "co-acme": hub(url), "t3-code": {} },
      },
      own,
    );

  it("never denies a Hub name, and counts a configured server of that name as replaced", () => {
    const plan = claude([
      ["co-acme", { url: COMPANY }],
      ["t3-code", { url: COMPANY }],
    ]);
    expect(plan.settings).toEqual({
      deniedMcpServers: [{ serverUrl: COMPANY }, { serverUrl: COMPANY + "/" }],
    });
    expect(plan.copies).toEqual([{ sourceId: "acme", off: true }]);
  });

  it("keeps the copy's command and address off the command line", () => {
    const plan = claude([
      ["bridge", { command: "npx", args: [COMPANY, "--header", "secret"] }],
      ["keyed", { url: COMPANY + "?key=secret" }],
    ]);
    expect(JSON.stringify(plan.settings)).not.toContain("secret");
  });

  it("adds to a deny list the person already passed", () => {
    expect(
      claude([], { deniedMcpServers: [{ serverName: "other" }], model: "opus" }).settings,
    ).toMatchObject({
      model: "opus",
      deniedMcpServers: [{ serverName: "other" }, { serverUrl: COMPANY }, expect.anything()],
    });
  });

  it("reports a name Claude cannot deny, unless the address already covers it", () => {
    expect(claude([["My Acme", { url: COMPANY }]]).copies).toEqual([
      { sourceId: "acme", off: true },
    ]);
    expect(claude([["My Acme", { command: "x", args: [COMPANY] }]]).copies).toEqual([
      { sourceId: "acme", off: false },
    ]);
  });

  it("never sends a wildcard as an address to deny", () => {
    const plan = claude([], undefined, "https://mcp.acme.test/*");
    expect(plan.settings).toBeUndefined();
  });
});
