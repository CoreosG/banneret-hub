"""Durable host bookings. Container commands run through the member's user manager."""
import base64
import hashlib
import json
import pwd
import re
import subprocess
import time
from datetime import datetime
from urllib.error import HTTPError
from urllib.parse import quote

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from relay import save


def timestamp(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def seconds(value):
    match = re.fullmatch(r"([1-9][0-9]*)([smh])", value)
    if not match:
        raise ValueError("Invalid sandbox duration")
    return int(match[1]) * {"s": 1, "m": 60, "h": 3600}[match[2]]


class Podman:
    def command(self, job, *args):
        try:
            account = pwd.getpwnam(job["login"])
        except KeyError as error:
            raise RuntimeError("Sandbox account missing") from error
        if account.pw_uid != job["uid"] or account.pw_uid < 1000:
            raise RuntimeError("Sandbox account changed")
        result = subprocess.run(["systemd-run", "--user", "--machine", job["login"] + "@.host",
                                 "--quiet", "--pipe", "--wait", "--collect", "--", "/usr/bin/podman",
                                 *args], text=True, capture_output=True, timeout=45, check=True)
        return result.stdout.strip()

    def containers(self, job):
        rows = self.command(job, "ps", "-a", "--no-trunc", "--filter",
                            "label=banneret.booking=" + job["name"], "--format", "{{.ID}}")
        ids = rows.splitlines()
        if any(not re.fullmatch("[0-9a-f]{64}", cid) for cid in ids):
            raise RuntimeError("Cannot verify sandbox container IDs")
        return ids

    def start(self, job):
        if self.containers(job):
            return
        size = job["limits"]
        self.command(job, "run", "--detach", "--pull=never", "--name", job["name"],
                     "--runtime=runsc", "--image-volume=ignore", "--security-opt=no-new-privileges",
                     "--cap-drop=ALL", "--cpus", str(size["cpu"]), "--memory", size["memory"],
                     "--storage-opt", "size=" + size["disk"], "--label", "banneret.sandbox=" + job["id"],
                     "--label", "banneret.booking=" + job["name"],
                     "-p", "127.0.0.1::3793", "-e", "BANNERET_HOME=/tmp/banneret",
                     "--entrypoint", "banneret", job["image"], "serve", "--host", "0.0.0.0", "--port", "3793")

    def machine(self, job):
        path = "/tmp/banneret/userdata/banneret/relays/" + hashlib.sha256(job["origin"].encode()).hexdigest()[:16] + ".json"
        script = "const fs=require('node:fs');if(fs.existsSync(process.argv[1]))process.stdout.write(fs.readFileSync(process.argv[1]))"
        data = json.loads(self.command(job, "exec", job["name"], "node", "-e", script, path) or "{}")
        if (data.get("state") == "configured" and data.get("relayOrigin") == job["origin"]
                and data.get("me", {}).get("id") == job["person"]):
            return data["machineId"]

    def has_work(self, job):
        sql = "SELECT EXISTS(SELECT 1 FROM projection_thread_sessions WHERE active_turn_id IS NOT NULL) AS busy"
        script = ("const db=new(require('node:sqlite').DatabaseSync)('/tmp/banneret/userdata/statev2.sqlite',{readOnly:true});"
                  "console.log(db.prepare(process.argv[1]).get().busy)")
        return self.command(job, "exec", job["name"], "node", "-e", script, sql) == "1"

    def clean(self, job):
        ids = self.containers(job)
        if ids:
            self.command(job, "rm", "--force", "--volumes", "--ignore", *ids)
        if self.containers(job):
            raise RuntimeError("Container still present")


class Bookings:
    def __init__(self, directory, config, runtime, report, boot, now=time.time):
        self.path = directory / "bookings.json"
        self.jobs = json.loads(self.path.read_text()) if self.path.exists() else {}
        self.config, self.runtime, self.report, self.boot, self.now = config, runtime, report, boot, now

    def persist(self):
        save(self.path, self.jobs)

    def accept(self, offer, size, policy, seats):
        key = hashlib.sha256(json.dumps([offer["id"], offer["offerId"]]).encode()).hexdigest()
        if key in self.jobs or timestamp(offer["deadline"]) <= self.now():
            return
        cfg = self.config["runner"]
        raw = base64.b64decode(offer["bodyBase64"], validate=True)
        header = "relay/v1\nPOST\n/relay/v1/pool/sandboxes\n{}\n{}\n{}\n".format(
            offer["machineId"], offer["counter"], offer["sentAt"])
        Ed25519PublicKey.from_public_bytes(base64.b64decode(offer["publicKey"], validate=True)).verify(
            base64.b64decode(offer["signature"], validate=True), header.encode() + raw)
        body = json.loads(raw)
        digest = body["image"]
        host = self.config["limits"]
        if body["hostId"] != host["id"] or policy["limits"]["id"] != host["id"] or body["size"] != size:
            return
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest) or digest not in cfg["images"]:
            return
        if sum(j["size"] == size for j in self.jobs.values()) >= min(
                policy["limits"]["sandbox_slots"][size], host["sandbox_slots"][size]):
            return
        limits = policy["sizes"][size]
        ceiling = self.config["sizes"][size]
        if not 0 < limits["cpu"] <= ceiling["cpu"]:
            return
        def capacity(value):
            if not re.fullmatch(r"[1-9][0-9]{0,8}[KMG]", value):
                raise ValueError("Invalid sandbox ceiling")
            return int(value[:-1]) * 1024 ** ("KMG".index(value[-1]) + 1)
        if any(capacity(limits[k]) > capacity(ceiling[k]) for k in ("disk", "memory")):
            return
        seat = next((s for s in seats if s["person"] == offer["personId"]), None)
        if not seat:
            login = cfg.get("accounts", {}).get(offer["personId"])
            if login:
                try:
                    account = pwd.getpwnam(login)
                except KeyError:
                    pass
                else:
                    if account.pw_uid >= 1000:
                        seat = {"name": account.pw_name, "uid": account.pw_uid}
        if not seat:
            self.jobs[key] = dict(id=offer["id"], offer=offer["offerId"], size=size, phase="offer",
                                  reason="member_account_missing", machine=None)
            self.persist()
            return
        self.jobs[key] = dict(id=offer["id"], offer=offer["offerId"], login=seat["name"], person=offer["personId"],
                              uid=seat["uid"], idle_limit=seconds(cfg["idle_limit"]), time_limit=seconds(cfg["time_limit"]),
                              size=size, limits=policy["sizes"][size], image=cfg["images"][digest]+"@"+digest,
                              name="banneret-"+key, origin=self.config["origin"], boot=self.boot, phase="offer",
                              machine=None, reason=None, until=self.now()+180, idle=self.now())
        self.persist()

    def retry_cleanup(self, sandbox_id, offer_id):
        for key, job in self.jobs.items():
            if (job["id"], job["offer"], job["phase"]) != (sandbox_id, offer_id, "quarantined"):
                continue
            self.runtime.clean(job)
            if job["stale"]:
                del self.jobs[key]
            else:
                job.update(phase="report_outcome", outcome="ended")
            self.persist()
            if key in self.jobs:
                self.step(key, [])
            return
        raise ValueError("No quarantined slot matches this sandbox and offer")

    def facts(self, facts, configured):
        for size in ("small", "large"):
            count = sum(j["size"] == size for j in self.jobs.values())
            facts["contention"]["freeSlots"][size] = max(0, configured[size]-count)
        facts["running"] = [j["id"] for j in self.jobs.values() if j["phase"]=="running"]

    def send(self, j, state, **extra):
        try:
            return self.report("sandboxes/"+quote(j["id"], safe="")+"/state",
                               dict(offerId=j["offer"], state=state, machineId=j["machine"], reason=j["reason"], **extra))
        except HTTPError as error:
            if error.code not in (403, 409):
                raise
            current = json.load(error).get("current", {})
            if current.get("sandboxId") != j["id"]:
                raise
            if current.get("offerId") != j["offer"]:
                j["phase"] = "stale"
            elif current["state"] == state:
                return current
            elif current["state"] == "ending":
                j["phase"] = "ending"
            else:
                raise
            self.persist()

    def step(self, key, directives):
        j = self.jobs[key]
        now = self.now()
        directive = next((d for d in directives if (d["sandboxId"], d["offerId"]) == (j["id"],j["offer"])), {})
        if j["phase"] == "offer":
            reply = self.send(j, "starting")
            if j["phase"] == "stale":
                del self.jobs[key]
                self.persist()
                return
            if j.get("reason") == "member_account_missing" and (reply or j["phase"] == "ending"):
                j.update(phase="report_cleanup", outcome="ended")
                self.persist()
            elif reply:
                j["phase"]="starting"
                self.persist()
        if j["phase"] in ("starting","running"):
            if j["boot"] != self.boot or directive.get("action") == "cancel":
                j.update(phase="ending", reason="host_restarted" if j["boot"] != self.boot else "cancelled")
            elif j["phase"] == "running" and directive.get("action") == "extend":
                j["until"]=timestamp(directive["endsAt"])
                self.persist()
                self.send(j,"running",endsAt=directive["endsAt"])
            if now >= j["until"] and j["phase"] in ("running","starting"):
                j.update(reason="expired" if j["phase"]=="running" else "startup_timeout",phase="ending")
            self.persist()
        if j["phase"] == "starting":
            try:
                self.runtime.start(j)
                machine=self.runtime.machine(j)
            except (RuntimeError, subprocess.SubprocessError, ValueError):
                j.update(phase="ending",reason="startup_failed")
            else:
                if machine:
                    j["machine"]=machine
                    reply=self.send(j,"running")
                    if reply:
                        j.update(phase="running", idle=now, until=timestamp(reply["endsAt"]) if reply.get("endsAt")
                                 else now+j["time_limit"])
            self.persist()
        if j["phase"] == "running":
            try:
                if self.runtime.has_work(j):
                    j["idle"]=now
                elif now-j["idle"] >= j["idle_limit"]:
                    j.update(phase="ending", reason="idle_limit")
            except (RuntimeError, subprocess.SubprocessError):
                j.update(phase="ending",reason="runtime_failed")
            self.persist()
        if j["phase"] in ("ending","stale"):
            stale=j["phase"]=="stale"
            try:
                self.runtime.clean(j)
            except (RuntimeError, subprocess.SubprocessError):
                outcome="cleanup_failed"
            else:
                outcome="ended"
            if stale and outcome=="ended":
                del self.jobs[key]
            else:
                j.update(phase="quarantined" if stale else "report_cleanup", outcome=outcome, stale=stale)
            self.persist()
        if j.get("phase")=="report_cleanup" and self.send(j,"ending"):
            j["phase"]="report_outcome"
            self.persist()
        if j.get("phase")=="report_outcome":
            if self.send(j,j["outcome"]):
                if j["outcome"]=="ended":
                    del self.jobs[key]
                else:
                    j["phase"]="quarantined"
                self.persist()
