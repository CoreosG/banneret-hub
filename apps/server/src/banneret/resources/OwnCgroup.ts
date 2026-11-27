// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Native filesystem statistics, cgroup paths and the injected sampling clock.
// All paths are server-selected. There is no API to inspect a different uid or directory.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { ResourceReport, WarningPolicy } from "@t3tools/contracts";

const defaults: WarningPolicy = {
  quota_percent: 85,
  memory_percent: 80,
  cpu_throttled_percent: 20,
  pids_percent: 80,
  pressure: { cpu: 40, memory: 10, io: 10 },
  host_busy: { memory_full_avg60: 2, io_some_avg60: 20, cpu_some_avg60: 50 },
};
const contents = (path: string) =>
  NodeFSP.readFile(path, "utf8").then(
    (s) => s.trim(),
    () => "",
  );
function number(raw: string | undefined) {
  if (!raw || !/^\d+(\.\d+)?$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}
function fields(raw: string) {
  return new Map(
    raw.split("\n").map((line) => {
      const [key, value] = line.split(/\s+/);
      return [key, number(value)] as const;
    }),
  );
}
function psi(raw: string) {
  function line(kind: string) {
    const row = raw.split("\n").find((l) => l.startsWith(kind + " "));
    const avg10 = number(row?.match(/\bavg10=([\d.]+)/)?.[1]);
    const avg60 = number(row?.match(/\bavg60=([\d.]+)/)?.[1]);
    return avg10 === null || avg60 === null ? null : { avg10, avg60 };
  }
  const some = line("some"),
    full = line("full");
  return some && full ? { some, full } : null;
}
function meter(used: number | null, limit: number | null, threshold: number) {
  return used === null
    ? null
    : { used, limit, warn: limit !== null && used >= (limit * threshold) / 100 };
}
const windowMs = 300_000;
interface Point {
  at: number;
  periods: number;
  throttled: number;
  usage: number;
}
export function createResourceReader(
  options = {
    proc: "/proc",
    cgroups: "/sys/fs/cgroup",
    uid: process.getuid?.() ?? -1,
    platform: HostProcess.Platform.defaultValue() as string,
    home: NodeOS.homedir(),
    now: Date.now,
  },
) {
  let points: Point[] = [];
  let lastKill: number | null = null;
  let killedUntil = 0;
  let lastSlice = "";
  return async (policy = defaults): Promise<ResourceReport> => {
    const linux = options.platform === "linux";
    const path = linux
      ? (await contents(NodePath.join(options.proc, "self/cgroup")))
          .split("\n")
          .find((l) => l.startsWith("0::/"))
          ?.slice(3)
      : undefined;
    const parts = path?.split("/") ?? [];
    const index = parts.indexOf("user-" + options.uid + ".slice");
    const slice =
      index >= 0 && !parts.includes("..")
        ? NodePath.join(options.cgroups, ...parts.slice(0, index + 1))
        : "";
    const local = (file: string) =>
      slice ? contents(NodePath.join(slice, file)) : Promise.resolve("");
    const host = (file: string) =>
      linux ? contents(NodePath.join(options.proc, file)) : Promise.resolve("");
    const [
      mem,
      cap,
      floor,
      events,
      stats,
      max,
      pids,
      pidsMax,
      meminfo,
      poolUsed,
      poolLimit,
      fs,
      ...samples
    ] = await Promise.all([
      local("memory.current"),
      local("memory.max"),
      local("memory.low"),
      local("memory.events"),
      local("cpu.stat"),
      local("cpu.max"),
      local("pids.current"),
      local("pids.max"),
      host("meminfo"),
      linux ? contents(NodePath.join(options.cgroups, "user.slice/memory.current")) : "",
      linux ? contents(NodePath.join(options.cgroups, "user.slice/memory.max")) : "",
      linux ? NodeFSP.statfs(options.home).catch(() => null) : null,
      ...["cpu", "io", "memory"].map((k) => host("pressure/" + k).then(psi)),
      ...["cpu", "io", "memory"].map((k) => local(k + ".pressure").then(psi)),
    ] as const);
    const now = options.now();
    if (slice !== lastSlice) {
      points = [];
      lastKill = null;
      killedUntil = 0;
      lastSlice = slice;
    }
    const counts = fields(stats);
    const periods = counts.get("nr_periods"),
      throttled = counts.get("nr_throttled"),
      usage = counts.get("usage_usec");
    const [quota, period] = max.split(/\s+/);
    const periodUsec = number(period),
      quotaUsec = number(quota);
    const coreLimit = periodUsec && quotaUsec !== null ? quotaUsec / periodUsec : null;
    let cpu: ResourceReport["own"]["cpu"] = null;
    let cpuCores: number | null = null;
    if (periods != null && throttled != null && usage != null) {
      const latest = points.at(-1);
      if (
        latest &&
        (now - latest.at > windowMs ||
          now < latest.at ||
          periods < latest.periods ||
          usage < latest.usage ||
          throttled < latest.throttled)
      )
        points = [];
      const previous = points.at(-1);
      if (previous && now > previous.at)
        cpuCores = (usage - previous.usage) / ((now - previous.at) * 1000);
      while (points.length > 1 && points[1]!.at <= now - windowMs) points.shift();
      const base = points[0];
      if (
        base &&
        now - base.at >= windowMs &&
        now - base.at <= windowMs + 30_000 &&
        periodUsec &&
        (quota === "max" || quotaUsec !== null)
      ) {
        const delta = periods - base.periods;
        const throttledPercent = delta
          ? Math.min(100, (100 * (throttled - base.throttled)) / delta)
          : 0;
        cpu = {
          periodUsec,
          quotaUsec,
          throttledPercent,
          warn: throttledPercent > policy.cpu_throttled_percent,
        };
      }
      if (!previous || now - previous.at >= 1000)
        points.push({ at: now, periods, throttled, usage });
    } else points = [];
    const oomKills = fields(events).get("oom_kill") ?? null;
    if (oomKills !== null && lastKill !== null && oomKills > lastKill) killedUntil = now + 60_000;
    const recentOomKill = now < killedUntil;
    const memoryMeter = meter(number(mem), number(cap), policy.memory_percent);
    const low = number(floor);
    const memory =
      memoryMeter && (cap === "max" || number(cap) !== null) && low !== null && oomKills !== null
        ? {
            ...memoryMeter,
            floor: low,
            oomKills,
            warn: memoryMeter.warn || recentOomKill,
          }
        : null;
    lastKill = oomKills;
    const [cpuPsi, ioPsi, memoryPsi] = samples;
    const pressure = { cpu: cpuPsi ?? null, memory: memoryPsi ?? null, io: ioPsi ?? null };
    const ownPressure = (sample: typeof cpuPsi, limit: number) =>
      sample ? { sample, limit, warn: sample.some.avg60 > limit } : null;
    const disk =
      fs && fs.blocks > 0
        ? meter(
            (fs.blocks - fs.bfree) * fs.bsize,
            (fs.blocks - fs.bfree + fs.bavail) * fs.bsize,
            policy.quota_percent,
          )
        : null;
    const inodes =
      fs && fs.files > 0 ? meter(fs.files - fs.ffree, fs.files, policy.quota_percent) : null;
    const pidMeter =
      pidsMax === "max" || number(pidsMax) !== null
        ? meter(number(pids), number(pidsMax), policy.pids_percent)
        : null;
    const available = number(meminfo.match(/^MemAvailable:\s+(\d+)/m)?.[1]);
    return {
      recentOomKill,
      cpuCores,
      coreLimit,
      own: {
        measuredAt: new Date(now).toISOString(),
        notMeasured:
          options.platform === "darwin"
            ? "macos"
            : options.platform === "win32"
              ? "windows"
              : !memory ||
                  !periodUsec ||
                  usage == null ||
                  !disk ||
                  !inodes ||
                  !pidMeter ||
                  samples.slice(3).some((s) => !s)
                ? "missing_files"
                : null,
        memory,
        cpu,
        disk,
        inodes,
        pids: pidMeter,
        pressure: {
          cpu: ownPressure(samples[3], policy.pressure.cpu),
          io: ownPressure(samples[4], policy.pressure.io),
          memory: ownPressure(samples[5], policy.pressure.memory),
        },
      },
      host: {
        pressure,
        busy:
          (memoryPsi?.full.avg60 ?? 0) > policy.host_busy.memory_full_avg60 ||
          (ioPsi?.some.avg60 ?? 0) > policy.host_busy.io_some_avg60 ||
          (cpuPsi?.some.avg60 ?? 0) > policy.host_busy.cpu_some_avg60,
        memAvailableBytes: available === null ? null : available * 1024,
        poolMemoryUsedBytes: number(poolUsed),
        poolMemoryLimitBytes: number(poolLimit),
      },
    };
  };
}
export const ownResources = createResourceReader();
export async function biggestFolders() {
  if (HostProcess.Platform.defaultValue() !== "linux") return [];
  const home = NodeOS.homedir();
  const { stdout } = await NodeUtil.promisify(NodeChildProcess.execFile)(
    "du",
    ["-x", "-B1", "--max-depth=1", "--null", "--", home],
    { timeout: 15000, maxBuffer: 2 * 1024 * 1024 },
  );
  return stdout
    .split("\0")
    .flatMap((entry) => {
      const tab = entry.indexOf("\t"),
        path = entry.slice(tab + 1),
        bytes = number(entry.slice(0, tab));
      return bytes !== null && path !== home ? [{ name: NodePath.basename(path), bytes }] : [];
    })
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 5);
}
