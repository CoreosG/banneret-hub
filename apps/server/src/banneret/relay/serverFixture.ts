// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off globalTimers:off globalTimersInEffect:off - boots the real server in a child process and calls it over HTTP and WebSocket.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const BIN = NodeURL.fileURLToPath(new URL("../../bin.ts", import.meta.url));

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const reservation = NodeHttp.createServer();
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", () => {
      const address = reservation.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      reservation.close(() => resolve(port));
    });
  });

/** Boots `bin.ts start` on a fresh home and a free loopback port, as the desktop app does. */
export async function bootServer(prepare?: (home: string) => void, bin = BIN) {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bh-wiring-"));
  prepare?.(home);
  const port = await freePort();
  const bootstrap = NodeCrypto.randomUUID();
  const child = NodeChildProcess.spawn(
    process.execPath,
    [bin, "start", "--bootstrap-fd", "3", "--log-level", "debug"],
    {
      env: {
        ...process.env,
        HOME: home,
        T3CODE_HOME: home,
        BANNERET_HOME: home,
        T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "0",
      },
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    },
  );
  const bootstrapPipe = child.stdio[3];
  if (bootstrapPipe === null || bootstrapPipe === undefined || !("write" in bootstrapPipe)) {
    throw new Error("no bootstrap pipe");
  }
  bootstrapPipe.end(
    JSON.stringify({
      mode: "desktop",
      noBrowser: true,
      port,
      t3Home: home,
      host: "127.0.0.1",
      desktopBootstrapToken: bootstrap,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    }),
  );
  let output = "";
  const ready = new Promise<void>((resolve, reject) => {
    for (const pipe of [child.stdout, child.stderr]) {
      pipe?.on("data", (data: Buffer) => {
        output = (output + data.toString()).slice(-16_384);
        if (output.includes("startup phase: complete")) resolve();
      });
    }
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`server exited ${code}:\n${output}`)));
  });
  return { child, home, origin: `http://127.0.0.1:${port}`, bootstrap, ready };
}

export async function stopServer(server: Awaited<ReturnType<typeof bootServer>>) {
  if (server.child.exitCode === null && server.child.signalCode === null) {
    const exited = new Promise((resolve) => server.child.once("exit", resolve));
    server.child.kill("SIGTERM");
    const timer = setTimeout(() => server.child.kill("SIGKILL"), 10_000);
    await exited;
    clearTimeout(timer);
  }
  NodeFS.rmSync(server.home, { recursive: true, force: true, maxRetries: 5 });
}
