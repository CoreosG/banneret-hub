// Banneret Hub: every TCP port listening on this host, for the Ports panel. Read-only: it never
// connects to a port, so binary protocols are not disturbed.
import { BANNERET_PORTS_WS_METHODS, type ListeningPort } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { windowsSystem32Path } from "@t3tools/shared/windowsSystem";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";

const TIMEOUT = Duration.seconds(5);
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

const LOOPBACK = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
const isLoopback = (host: string) => LOOPBACK.has(host) || host.startsWith("127.");

interface Listener {
  readonly host: string;
  readonly port: number;
  readonly pid: number | null;
  readonly processName: string | null;
}

/** Splits `host:port`, `[v6]:port` or `*:port`. */
function splitEndpoint(endpoint: string): { host: string; port: number } | null {
  const colon = endpoint.lastIndexOf(":");
  if (colon <= 0) return null;
  const port = Number(endpoint.slice(colon + 1));
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) return null;
  return { host: endpoint.slice(0, colon).replace(/^\[|\]$/g, ""), port };
}

/** `netstat -ano` rows whose foreign endpoint ends in `:0` are listeners in any locale. */
export function parseNetstat(output: string): Listener[] {
  return output.split(/\r?\n/).flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields[0]?.toUpperCase() !== "TCP" || !fields[2]?.endsWith(":0")) return [];
    const endpoint = splitEndpoint(fields[1] ?? "");
    const pid = Number(fields.at(-1));
    return endpoint
      ? [{ ...endpoint, pid: Number.isInteger(pid) && pid > 0 ? pid : null, processName: null }]
      : [];
  });
}

/** `tasklist /FO CSV /NH`: "image","pid",... */
export function parseTasklist(output: string): Map<number, string> {
  const names = new Map<number, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^"([^"]*)","(\d+)"/.exec(line.trim());
    if (match) names.set(Number(match[2]), match[1]!);
  }
  return names;
}

/** `lsof -iTCP -sTCP:LISTEN -P -n -F pcn`: p<pid>, c<command>, n<endpoint> records. */
export function parseLsof(output: string): Listener[] {
  const listeners: Listener[] = [];
  let pid: number | null = null;
  let processName: string | null = null;
  for (const line of output.split("\n")) {
    const value = line.slice(1).trim();
    if (line.startsWith("p")) {
      pid = Number(value) || null;
      processName = null;
    } else if (line.startsWith("c")) {
      processName = value;
    } else if (line.startsWith("n")) {
      const endpoint = splitEndpoint(value);
      if (endpoint) listeners.push({ ...endpoint, pid, processName });
    }
  }
  return listeners;
}

/** `ss -Hltnp`: LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=12,fd=19)) */
export function parseSs(output: string): Listener[] {
  return output.split("\n").flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    const endpoint = splitEndpoint(fields[3] ?? "");
    if (!endpoint) return [];
    const owner = /\(\("([^"]+)",pid=(\d+)/.exec(line);
    return [
      {
        ...endpoint,
        pid: owner ? Number(owner[2]) : null,
        processName: owner ? owner[1]! : null,
      },
    ];
  });
}

/** One row per port; a port is loopback-only when every bind of it is. */
export function mergeListeners(listeners: ReadonlyArray<Listener>): ListeningPort[] {
  const byPort = new Map<number, ListeningPort>();
  for (const listener of listeners) {
    const previous = byPort.get(listener.port);
    byPort.set(listener.port, {
      port: listener.port,
      pid: previous?.pid ?? listener.pid,
      processName: previous?.processName ?? listener.processName,
      loopbackOnly: (previous?.loopbackOnly ?? true) && isLoopback(listener.host),
    });
  }
  return [...byPort.values()].toSorted((a, b) => a.port - b.port);
}

const list = Effect.fn("ListeningPorts.list")(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const config = yield* ServerConfig.ServerConfig;
  const platform = HostProcess.Platform.defaultValue();
  const run = (command: string, args: ReadonlyArray<string>) =>
    runner.run({ command, args, timeout: TIMEOUT, maxOutputBytes: MAX_OUTPUT_BYTES }).pipe(
      Effect.map((result) => (result.code === 0 || result.code === null ? result.stdout : null)),
      Effect.orElseSucceed(() => null),
    );

  let listeners: Listener[] = [];
  if (platform === "win32") {
    const env = yield* HostProcess.Environment;
    const netstat = windowsSystem32Path(env, "netstat.exe");
    const [tcp4, tcp6, tasks] = yield* Effect.all(
      [
        run(netstat, ["-ano", "-p", "tcp"]),
        run(netstat, ["-ano", "-p", "tcpv6"]),
        run(windowsSystem32Path(env, "tasklist.exe"), ["/FO", "CSV", "/NH"]),
      ],
      { concurrency: 3 },
    );
    const names = parseTasklist(tasks ?? "");
    listeners = parseNetstat(`${tcp4 ?? ""}\n${tcp6 ?? ""}`).map((listener) => ({
      ...listener,
      processName: listener.pid === null ? null : (names.get(listener.pid) ?? null),
    }));
  } else {
    const ss = platform === "linux" ? yield* run("ss", ["-Hltnp"]) : null;
    if (ss !== null) {
      listeners = parseSs(ss);
    } else {
      listeners = parseLsof(
        (yield* run("lsof", ["-iTCP", "-sTCP:LISTEN", "-P", "-n", "-F", "pcn"])) ?? "",
      );
    }
  }
  return {
    ports: mergeListeners(listeners),
    serverPort: config.port > 0 ? config.port : null,
  };
});

/** Handlers for the `banneretPorts.*` RPCs, spread into the WebSocket handler group. */
export const rpcHandlers = {
  // A per-call runner keeps this handler's requirements to what every server layer provides.
  [BANNERET_PORTS_WS_METHODS.list]: () => list().pipe(Effect.provide(ProcessRunner.layer)),
};
