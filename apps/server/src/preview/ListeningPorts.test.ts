import { describe, expect, it } from "@effect/vitest";

import {
  mergeListeners,
  parseLsof,
  parseNetstat,
  parseSs,
  parseTasklist,
} from "./ListeningPorts.ts";

describe("ListeningPorts parsers", () => {
  it("reads netstat listeners in any locale and joins tasklist names", () => {
    const netstat = [
      "  Proto  Endereço local         Endereço externo       Estado         PID",
      "  TCP    0.0.0.0:135            0.0.0.0:0              ESCUTANDO      1100",
      "  TCP    127.0.0.1:5173         0.0.0.0:0              ESCUTANDO      4242",
      "  TCP    127.0.0.1:5173         127.0.0.1:50123        ESTABELECIDA   4242",
      "  TCP    [::1]:5173             [::]:0                 ESCUTANDO      4242",
    ].join("\r\n");
    const names = parseTasklist(
      '"svchost.exe","1100","Services","0","10.000 K"\r\n"node.exe","4242","Console","1","80.000 K"',
    );
    const ports = mergeListeners(
      parseNetstat(netstat).map((listener) => ({
        ...listener,
        processName: listener.pid === null ? null : (names.get(listener.pid) ?? null),
      })),
    );
    expect(ports).toEqual([
      { port: 135, pid: 1100, processName: "svchost.exe", loopbackOnly: false },
      { port: 5173, pid: 4242, processName: "node.exe", loopbackOnly: true },
    ]);
  });

  it("reads lsof records", () => {
    const output = [
      "p812",
      "cnode",
      "n127.0.0.1:3000",
      "n[::1]:3000",
      "p900",
      "cpostgres",
      "n*:5432",
    ].join("\n");
    expect(mergeListeners(parseLsof(output))).toEqual([
      { port: 3000, pid: 812, processName: "node", loopbackOnly: true },
      { port: 5432, pid: 900, processName: "postgres", loopbackOnly: false },
    ]);
  });

  it("reads ss rows with and without an owner", () => {
    const output = [
      'LISTEN 0      511        127.0.0.1:8080      0.0.0.0:*    users:(("python3",pid=77,fd=3))',
      "LISTEN 0      4096       0.0.0.0:22          0.0.0.0:*",
    ].join("\n");
    expect(mergeListeners(parseSs(output))).toEqual([
      { port: 22, pid: null, processName: null, loopbackOnly: false },
      { port: 8080, pid: 77, processName: "python3", loopbackOnly: true },
    ]);
  });
});
