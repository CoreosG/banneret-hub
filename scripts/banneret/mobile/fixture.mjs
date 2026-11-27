// Runs in the fork. Only the HTTP address, pairing URL and fixture IDs cross to the stock client.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { renderTerminalQrCode } from "../../../apps/server/src/startupAccess.ts";
import { bootServer, stopServer } from "../../../apps/server/src/banneret/relay/serverFixture.ts";
import { withNotes } from "../../../apps/server/src/banneret/memory/store.ts";

const [stock] = process.argv.slice(2);
const threadId = NodeCrypto.randomUUID();
const projectId = NodeCrypto.randomUUID();
const relay = "https://company.example";
const company = "ent-" + NodeCrypto.createHash("sha256").update(relay).digest("hex").slice(0, 16);
const bin = NodePath.resolve("apps/server/dist/bin.mjs");
const server = await bootServer((home) => {
  NodeFS.mkdirSync(NodePath.join(home, "userdata"), { recursive: true });
  const launcher = NodePath.join(home, "fx");
  const fake = new URL("../../mobile-behavior/fake-fx.ts", import.meta.url);
  NodeFS.writeFileSync(launcher, '#!/bin/sh\nexec node "$MOBILE_FIXTURE_FX" "$@"\n', {
    mode: 0o700,
  });
  NodeFS.writeFileSync(
    NodePath.join(home, "userdata/settings.json"),
    JSON.stringify({
      providerInstances: {
        evalbot: {
          driver: "fx",
          displayName: "Eval Bot",
          environment: [{ name: "MOBILE_FIXTURE_FX", value: decodeURIComponent(fake.pathname) }],
          config: { enabled: true, binaryPath: launcher },
        },
      },
    }),
  );
}, bin);
try {
  await server.ready;
  const { environmentId } = await (
    await fetch(server.origin + "/.well-known/t3/environment")
  ).json();
  const dir = NodePath.join(server.home, "userdata/banneret");
  const workspace = NodePath.join(server.home, "project");
  NodeFS.mkdirSync(workspace);
  NodeFS.mkdirSync(NodePath.join(dir, "memory"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(dir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        {
          id: company,
          name: "Company",
          kind: "enterprise",
          projectKeys: [`path:${environmentId}:${workspace}`],
          relay: { origin: relay, displayName: "Company" },
          updatedAt: new Date().toISOString(),
        },
      ],
    }),
  );
  NodeFS.writeFileSync(
    NodePath.join(dir, "orchestrators.json"),
    JSON.stringify({
      [company]: {
        main: threadId,
        projects: { [projectId]: threadId },
      },
    }),
  );
  const store = NodeCrypto.createHash("sha256")
    .update(JSON.stringify([company, null]))
    .digest("hex");
  withNotes(NodePath.join(dir, "memory", store + ".sqlite"), projectId, Date.now(), (notes) => {
    notes.propose({
      key: "private",
      text: "Private company note",
      source: threadId,
      kind: "project",
      scope: "project",
    });
    notes.use("private", threadId);
  });
  const pairUrl = () => {
    const output = NodeChildProcess.execFileSync(
      process.execPath,
      [bin, "pair", "--base-dir", server.home],
      {
        encoding: "utf8",
        env: { ...process.env, HOME: server.home, BANNERET_HOME: server.home },
      },
    );
    const url = /^Pairing URL: (.+)$/m.exec(output)?.[1];
    if (!url || !output.includes(renderTerminalQrCode(url))) {
      throw new Error("The terminal QR must encode the phone pairing URL.");
    }
    return url;
  };
  NodeChildProcess.execFileSync(
    NodePath.join(stock, "node_modules/.bin/vp"),
    ["test", "run", "src/features/connection/banneret.test.ts"],
    {
      cwd: NodePath.join(stock, "apps/mobile"),
      stdio: "inherit",
      env: {
        ...process.env,
        MOBILE_FIXTURE: JSON.stringify({
          pairUrl: pairUrl(),
          devicePairUrl: pairUrl(),
          workspace,
          projectId,
          threadId,
        }),
      },
    },
  );
} finally {
  await stopServer(server);
}
