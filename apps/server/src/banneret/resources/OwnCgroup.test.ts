// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Native filesystem statistics, cgroup paths and the injected sampling clock.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it, expect } from "vite-plus/test";
import { createResourceReader } from "./OwnCgroup.ts";

it("reads only the matching v2 user slice and measures five minutes of throttling", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "own-cgroup-"));
  try {
    const slice = NodePath.join(root, "user.slice/user-123.slice");
    await NodeFSP.mkdir(slice, { recursive: true });
    await NodeFSP.mkdir(NodePath.join(root, "self"));
    await NodeFSP.writeFile(
      NodePath.join(root, "self/cgroup"),
      "0::/user.slice/user-123.slice/session.scope\n",
    );
    await NodeFSP.writeFile(NodePath.join(slice, "cpu.max"), "max 100000");
    await NodeFSP.writeFile(NodePath.join(slice, "pids.current"), "7");
    await NodeFSP.writeFile(NodePath.join(slice, "pids.max"), "max");
    let now = 0;
    const read = createResourceReader({
      proc: root,
      cgroups: root,
      uid: 123,
      platform: "linux",
      home: root,
      now: () => now,
    });
    await NodeFSP.writeFile(
      NodePath.join(slice, "cpu.stat"),
      "usage_usec 100\nnr_periods 20\nnr_throttled 5\nthrottled_usec 10",
    );
    const first = await read();
    expect(first.own.cpu).toBeNull();
    expect(first.own.memory).toBeNull();
    const pressure =
      "some avg10=22.20 avg60=21.00 avg300=15.00 total=1000\nfull avg10=1.20 avg60=1.00 avg300=0.90 total=100";
    await NodeFSP.mkdir(NodePath.join(root, "pressure"));
    await NodeFSP.writeFile(NodePath.join(root, "pressure/io"), pressure);
    await NodeFSP.writeFile(NodePath.join(slice, "memory.pressure"), pressure);
    await NodeFSP.writeFile(NodePath.join(slice, "memory.max"), "1000");
    await NodeFSP.writeFile(NodePath.join(slice, "memory.current"), "100");
    await NodeFSP.writeFile(NodePath.join(slice, "memory.low"), "50");
    await NodeFSP.writeFile(NodePath.join(slice, "memory.events"), "high 0\nmax 0\noom_kill 2");
    const baseline = await read();
    expect(baseline.own.memory?.warn).toBe(false);
    expect(baseline.host.busy).toBe(true);
    expect(baseline.own.pressure.memory?.warn).toBe(true);
    await NodeFSP.writeFile(NodePath.join(slice, "memory.events"), "high 0\nmax 1\noom_kill 3");

    expect(first.own.pids).toEqual({ used: 7, limit: null, warn: false });
    now = 300000;
    await NodeFSP.writeFile(
      NodePath.join(slice, "cpu.stat"),
      "usage_usec 300000100\nnr_periods 120\nnr_throttled 35\nthrottled_usec 20",
    );
    const second = await read();
    expect(second.own.cpu).toEqual({
      quotaUsec: null,
      periodUsec: 100000,
      throttledPercent: 30,
      warn: true,
    });
    expect(second.cpuCores).toBe(1);
    expect(second.recentOomKill).toBe(true);
    expect(second.own.memory?.warn).toBe(true);
    await NodeFSP.writeFile(
      NodePath.join(root, "self/cgroup"),
      "0::/user.slice/user-987.slice/session.scope",
    );
    const moved = await read();
    expect(moved.own.pids).toBeNull();
    expect(moved.own.cpu).toBeNull();
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it.each([
  ["darwin", "macos"],
  ["win32", "windows"],
])("marks %s as not measured", async (platform, reason) => {
  const report = await createResourceReader({
    platform,
    uid: 123,
    home: "",
    proc: "",
    cgroups: "",
    now: () => 0,
  })();
  expect(report.own.notMeasured).toBe(reason);
  expect(report.own.disk).toBeNull();
  expect(report.host.pressure.cpu).toBeNull();
});
