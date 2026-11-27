import json
import os
import selectors
import subprocess
import tempfile
import unittest
from pathlib import Path
from urllib import request

from facts import collect, quota_rows
from provision import DATA, HOMES, filesystem, provision

KIT = Path(__file__).resolve().parent
REPO = KIT.parents[2]
POOL = json.loads((REPO / "docs/banneret/relay-v1/examples/pool-config.json").read_text())


class PoolKit(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.state = self.root / "var/lib/banneret-pool"
        self.state.mkdir(parents=True, mode=0o700)
        self.config = dict(hubVersion="0.1.1300", limits=POOL["hosts"][0], warnings=POOL["warnings"], sizes=POOL["sandboxes"]["sizes"])

    def write(self, path, value):
        file = self.root / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(value)

    def test_measurements(self):
        seat = dict(person="alice", uid=1234, project=1234)
        sample = "some avg10=45 avg60=60 total=1\nfull avg10=0 avg60=0 total=1"
        for kind in ("cpu", "memory", "io"):
            self.write("proc/pressure/" + kind, sample)
        self.write("proc/meminfo", "MemAvailable: 123 kB\n")
        group = "sys/fs/cgroup/user.slice/"
        self.write(group + "memory.current", "30")
        self.write(group + "memory.max", "max")
        member = group + "user-1234.slice/"
        for filename, value in {"cpu.stat": "nr_periods 100\nnr_throttled 12", "pids.current": "9",
                                "pids.max": "10", "memory.max": "max", "memory.current": "500",
                                "memory.events": "oom_kill 0"}.items():
            self.write(member + filename, value)
        for kind in ("cpu", "memory", "io"):
            self.write(member + kind + ".pressure", sample)
        history = {}
        rows = quota_rows("#1234 99 0 100 00 [------]", 1024, 85)
        def facts(now):
            return collect(self.root, self.config, POOL["warnings"], [seat], [rows, rows], history, "now", now)
        facts(0)
        self.write(member + "cpu.stat", "nr_periods 200\nnr_throttled 52")
        self.write(member + "memory.events", "oom_kill 1")
        report = facts(300)
        self.assertTrue(report["contention"]["busy"])
        self.assertEqual(report["contention"]["memAvailableBytes"], 123*1024)
        resources = report["workspaces"][0]["resources"]
        self.assertEqual(set(resources), {"notMeasured", "disk", "inodes", "warnings"})
        self.assertEqual(resources["disk"], dict(used=99*1024, limit=100*1024, warn=True))
        self.assertIsNone(resources["notMeasured"])
        self.assertTrue(all(resources["warnings"].values()))

    def test_admin(self):
        (self.root / DATA[1:]).mkdir(parents=True)
        calls = []
        accounts = {}
        def fake(*args, optional=False):
            calls.append(args)
            if args[0] == "findmnt":
                if args[-1] == "FSTYPE":
                    return "ext4"
                return "xfs /dev/loop5 rw,prjquota" if any(a[0]=="mount" for a in calls) else ""
            if args[0] == "losetup":
                return str(self.root / DATA[1:] / "member-homes.xfs")
            if args[0] == "fallocate":
                os.truncate(args[-1], 1024**3)
            if args[0] == "getent":
                return accounts.get(args[-1], "")
            if args[0] == "useradd":
                accounts["alice"] = "alice:x:1234:1234::" + str(self.root / HOMES[1:] / "alice") + ":/bin/bash"
            return ""
        def fail_service(*args, optional=False):
            if args[:2] == ("systemctl", "enable"):
                raise RuntimeError("service failed")
            return fake(*args, optional=optional)
        filesystem(self.root, "1G", fake)
        with self.assertRaisesRegex(RuntimeError, "service failed"):
            provision(self.root, self.state, "p_alice", "alice", 1234, 24101, self.config, fail_service)
        self.assertFalse(json.loads((self.state/"seats.json").read_text())[0]["ready"])
        for _ in range(2):
            filesystem(self.root, "1G", fake)
            provision(self.root, self.state, "p_alice", "alice", 1234, 24101, self.config, fake)
        unit = (self.root/"etc/systemd/system/banneret-seat-1234.service").read_text()
        for setting in ("User=alice", "Slice=user-1234.slice", "BANNERET_POOL_HOST_ID=dev",
                        "--host 127.0.0.1 --port 24101"):
            self.assertIn(setting, unit)
        self.assertIn(("systemctl", "enable", "--now", "banneret-seat-1234.service"), calls)
        with self.assertRaises(ValueError):
            provision(self.root, self.state, "p_bob", "bob", 1235, 24101, self.config, fake)
        slice_settings = (self.root/"etc/systemd/system/user-1234.slice.d/60-banneret.conf").read_text()
        self.assertIn("SocketBindAllow=tcp:24101", slice_settings)
        self.assertIn("SocketBindDeny=tcp:20000-29999", slice_settings)
        for command in ("mkfs.xfs", "mount", "useradd"):
            self.assertEqual(sum(c[0] == command for c in calls), 1)
        with self.assertRaises(ValueError):
            provision(self.root, self.state, "p_eve", "alice", 1234, 24101, self.config, fake)
        self.assertIn("CPUQuota=400%", (self.root/"etc/systemd/system/user-1234.slice.d/60-banneret.conf").read_text())

    def test_founder_join_and_report(self):
        self.write("fake.json", json.dumps(dict(pool=POOL)))
        def stop(proc):
            if proc.poll() is None:
                proc.terminate()
            proc.wait(timeout=10)
            proc.stdout.close()
        def line(proc):
            with selectors.DefaultSelector() as sel:
                sel.register(proc.stdout, selectors.EVENT_READ)
                self.assertTrue(sel.select(20), "timed out waiting for process")
            return proc.stdout.readline().strip()
        relay = subprocess.Popen(["node", "packages/banneret-relay-fake/src/bin.ts", "--quiet",
                                  "--config", self.root/"fake.json"], cwd=REPO, stdout=subprocess.PIPE, text=True)
        self.addCleanup(stop, relay)
        origin = line(relay)
        self.config["origin"] = origin
        # The relay ceiling is lower than the local offer.
        self.config["limits"] = dict(self.config["limits"], sandbox_slots=dict(small=5, large=2))
        self.write("var/lib/banneret-pool/seats.json", json.dumps([
            dict(person="p_alice", name="alice", uid=1234, project=1234, ready=True)]))
        self.write("quota-b", "#1234 91 0 100 00 [------]")
        self.write("quota-i", "#1234 4 0 0 00 [------]")
        self.write("etc/banneret-pool.json", json.dumps(self.config))
        def cli(*args):
            return [KIT/"banneret", "pool", *args, "--root", self.root, "--apply"]
        joining = subprocess.Popen(cli("join"), stdout=subprocess.PIPE, text=True)
        self.addCleanup(stop, joining)
        url, code = line(joining).split()[-2:]
        pairing = url.split("pairing=")[1]
        body = json.dumps(dict(code=code, person=dict(login="maintainer", role="founder"))).encode()
        with request.urlopen(request.Request(origin+"/conformance/v1/pairings/"+pairing+"/confirm",
                              data=body, headers={"Content-Type":"application/json"})) as response:
            self.assertEqual(response.status, 200)
        self.assertEqual(joining.wait(timeout=15), 0)
        subprocess.run(cli("agent", "--once"), check=True)
        self.assertEqual(json.loads((self.state/"policy.json").read_text())["limits"], POOL["hosts"][0])
        self.assertEqual((self.state/"credential.json").stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
