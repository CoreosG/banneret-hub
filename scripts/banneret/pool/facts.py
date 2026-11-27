"""Linux pool measurements. Only the final wire projection leaves the host."""
import re
import time


def read(path):
    try:
        return path.read_text().strip()
    except FileNotFoundError:
        return None


def number(path):
    value = read(path)
    return int(value) if value and value.isdecimal() else None


def fields(path):
    return dict(line.split() for line in (read(path) or "").splitlines())


def psi(path):
    rows = {}
    for line in (read(path) or "").splitlines():
        kind, *values = line.split()
        stats = dict(item.split("=") for item in values)
        rows[kind] = {key: float(stats[key]) for key in ("avg10", "avg60")}
    return rows if rows.keys() == {"some", "full"} else None


def high(used, limit, threshold):
    return bool(limit and used is not None and 100 * used >= threshold * limit)


def quota_rows(output, scale, threshold):
    rows = {}
    for line in output.splitlines():
        match = re.match(r"^\s*#?(\d+)\s+(\d+)\s+\d+\s+(\d+)(?:\s|$)", line)
        if match:
            project, used, limit = map(int, match.groups())
            rows[project] = dict(used=used * scale, limit=limit * scale or None,
                                 warn=high(used, limit, threshold))
    return rows


def collect(root, config, warnings, seats, quotas, history, measured_at, now=None):
    now = time.monotonic() if now is None else now
    cg = root / "sys/fs/cgroup/user.slice"
    pressure = {kind: psi(root / "proc/pressure" / kind) for kind in ("cpu", "io", "memory")}
    available = re.search(r"^MemAvailable:\s+(\d+) kB$", read(root / "proc/meminfo") or "", re.M)
    used, limit = number(cg / "memory.current"), number(cg / "memory.max")
    missing = None in pressure.values() or not available or used is None or read(cg / "memory.max") is None
    busy = any(pressure[k] and pressure[k][row]["avg60"] > warnings["host_busy"][key]
               for k, row, key in (("memory", "full", "memory_full_avg60"),
                                   ("cpu", "some", "cpu_some_avg60"), ("io", "some", "io_some_avg60")))
    workspaces = []
    for seat in seats:
        path = cg / f"user-{seat['uid']}.slice"
        cpu = fields(path / "cpu.stat")
        oom = fields(path / "memory.events").get("oom_kill")
        samples = history.setdefault(seat["uid"], [])
        cpu_warn = oom_warn = cpu_measured = False
        if "nr_periods" in cpu and "nr_throttled" in cpu and oom is not None:
            periods, throttled = int(cpu["nr_periods"]), int(cpu["nr_throttled"])
            if samples and (now - samples[-1][0] > 300 or periods < samples[-1][1] or throttled < samples[-1][2]):
                samples.clear()
            if samples:
                oom_warn = int(oom) > samples[-1][3]
            while len(samples) > 1 and samples[1][0] <= now - 300:
                samples.pop(0)
            samples.append((now, periods, throttled, int(oom)))
            delta = periods - samples[0][1]
            cpu_measured = 300 <= now - samples[0][0] <= 335
            cpu_warn = cpu_measured and delta > 0 and 100 * (throttled - samples[0][2]) > delta * warnings["cpu_throttled_percent"]
        else:
            samples.clear()
        memory, pids = number(path / "memory.current"), number(path / "pids.current")
        local = {k: psi(path / (k + ".pressure")) for k in pressure}
        disk, inodes = (rows.get(seat["project"]) for rows in quotas)
        incomplete = (None in (disk, inodes, memory, pids, oom, *local.values())
                      or not cpu_measured or any(read(path / f) is None for f in ("memory.max", "pids.max")))
        flags = dict(memory=oom_warn or high(memory, number(path / "memory.max"), warnings["memory_percent"]),
                     pids=high(pids, number(path / "pids.max"), warnings["pids_percent"]),
                     cpu=cpu_warn, pressure=any(sample and sample["some"]["avg60"] > warnings["pressure"][k]
                                                for k, sample in local.items()))
        workspaces.append(dict(personId=seat["person"], state="ready_to_join",
                               resources=dict(disk=disk, inodes=inodes, warnings=flags,
                                              notMeasured="missing_files" if incomplete else None)))
    return dict(limits=config["limits"], sizes=config["sizes"], running=[], workspaces=workspaces,
                contention=dict(measuredAt=measured_at, pressure=pressure, busy=busy,
                                memAvailableBytes=int(available[1])*1024 if available else None,
                                poolMemoryUsedBytes=used, poolMemoryLimitBytes=limit,
                                notMeasured="missing_files" if missing else None,
                                freeSlots=dict(small=0, large=0)))
