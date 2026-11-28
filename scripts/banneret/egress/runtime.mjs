import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import { bootServer, stopServer } from "../../../apps/server/src/banneret/relay/serverFixture.ts";

const { chromium } = NodeModule.createRequire(NodePath.resolve("apps/web/package.json"))(
  "playwright",
);
const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "banneret-egress-"));
const log = NodePath.join(dir, "requests.jsonl");
NodeFS.writeFileSync(log, "");
const probe = NodeURL.fileURLToPath(new URL("./probe.cjs", import.meta.url));
const requests = [];
const record = (url) => {
  const { hostname: host, origin, pathname } = new URL(url);
  requests.push(origin + pathname);
  return ["127.0.0.1", "localhost", "[::1]"].includes(host);
};

// Keep the host's service variables, proxy, credentials and providers out of the fixture.
const previous = process.env;
process.env = {
  PATH: NodePath.resolve(dir, "empty-path"),
  TMPDIR: dir,
  NODE_OPTIONS: "--require=" + probe,
  EGRESS_LOG: log,
};
let server;
let browser;
let fake;
try {
  server = await bootServer(undefined, NodePath.resolve("apps/server/dist/bin.mjs"));
  process.env = previous;
  await Promise.race([
    server.ready,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Server startup timed out")), 60_000).unref();
    }),
  ]);
  browser = await chromium.launch({ args: ["--disable-background-networking"] });
  const context = await browser.newContext({ serviceWorkers: "block" });
  await context.route("**/*", (route) =>
    record(route.request().url()) ? route.continue() : route.abort(),
  );
  await context.routeWebSocket("**/*", (socket) => {
    if (record(socket.url())) socket.connectToServer();
    else socket.close();
  });
  const page = await context.newPage();
  await page.goto(server.origin + "/pair#token=" + encodeURIComponent(server.bootstrap));
  await page.locator("#root").locator(":scope > *").first().waitFor({ state: "attached" });
  await page.waitForFunction(() => document.body.innerText.trim().length > 0);
  const { startFakeRelay } = await import("../../../packages/banneret-relay-fake/src/fake.ts");
  fake = await startFakeRelay({ port: 0 });
  const switcher = page.getByRole("button", { name: "Switch workspace" });
  await page.getByRole("button", { name: "Start without an agent" }).click();
  await switcher.click();
  await page.getByText("New workspace…", { exact: true }).click();
  await page.getByRole("button", { name: "Enterprise", exact: true }).click();
  await page.getByLabel("Relay address").fill(fake.url);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Join Example Company" }).waitFor();
  NodeAssert.ok(
    requests.some((url) => url.startsWith(server.origin + "/")),
    "Browser recorder saw no loopback request",
  );
  NodeAssert.ok(
    NodeFS.readFileSync(log, "utf8").includes(new URL(fake.url).origin + "/"),
    "Server recorder missed relay discovery",
  );
} finally {
  process.env = previous;
  try {
    await browser?.close();
    if (server) await stopServer(server);
    await fake?.close();
    requests.push(
      ...NodeFS.readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    );
    const upstream =
      /(?:^|\.)(?:t3\.codes|t3\.chat|ping\.gg|t3\.sh|t3code\.(?:dev|app|com)|posthog\.com)\.?$/i;
    const hosts = requests.map((endpoint) => new URL(endpoint).hostname);
    console.log("Observed destinations:", [...new Set(hosts)].sort());
    NodeAssert.deepEqual(
      requests.filter((endpoint) =>
        /(?:github(?:usercontent)?\.com\/(?:repos\/)?pingdotgg\/t3code|registry\.npmjs\.org\/t3(?:\/|$)|u\.expo\.dev\/d763fcb8)/i.test(
          endpoint,
        ),
      ),
      [],
    );
    NodeAssert.deepEqual(
      hosts.filter((host) => upstream.test(host)),
      [],
    );
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}
