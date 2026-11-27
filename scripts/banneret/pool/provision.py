"""Manual Linux administration for a dedicated pool data disk."""
import json
import os
import re
import subprocess
import tempfile

from relay import save

DATA = "/srv/banneret-data"
IMAGE = DATA + "/member-homes.xfs"
HOMES = "/srv/banneret-homes"


def run(*args, optional=False):
    result = subprocess.run(args, text=True, stdout=subprocess.PIPE, check=False)
    if result.returncode and not (optional and result.returncode in (1, 2)):
        raise RuntimeError(f"{args[0]} failed ({result.returncode})")
    return result.stdout.strip()


def mounted(call, image, homes):
    row = call("findmnt", "-rn", "-M", str(homes), "-o", "FSTYPE,SOURCE,OPTIONS", optional=True)
    if not row:
        return False
    fs, device, opts = row.split()
    if (fs != "xfs" or not {"prjquota", "pquota"}.intersection(opts.split(",")) or
        call("losetup", "-lnO", "BACK-FILE", device) != str(image)):
        raise ValueError("Unexpected filesystem or project quotas disabled at " + str(homes))
    return True


def filesystem(root, size, call=run):
    if not re.fullmatch(r"[1-9][0-9]{0,5}G", size):
        raise ValueError("Image size must be a positive number of GiB followed by G")
    image, homes = (root / p[1:] for p in (IMAGE, HOMES))
    if call("findmnt", "-rn", "-M", str(image.parent), "-o", "FSTYPE") != "ext4":
        raise ValueError("Mount the ext4 data disk at " + DATA)
    if image.is_symlink() or homes.is_symlink():
        raise ValueError("Unexpected symlink in pool paths")
    if not image.exists():
        with tempfile.NamedTemporaryFile(dir=image.parent) as fresh:
            call("fallocate", "-l", size, fresh.name)
            call("mkfs.xfs", fresh.name)
            os.link(fresh.name, image)
    if not image.is_file() or image.stat().st_size != int(size[:-1]) * 1024**3:
        raise ValueError("Existing image does not match the requested size")
    homes.mkdir(exist_ok=True)
    if not mounted(call, image, homes):
        if any(homes.iterdir()):
            raise ValueError("Refusing to cover existing files")
        call("mount", "-t", "xfs", "-o", "loop,prjquota,nodev,nosuid", str(image), str(homes))
        if not mounted(call, image, homes):
            raise ValueError("Mount verification failed")


def checked_seat_policy(policy, local):
    limits = policy["limits"]
    if limits["id"] != local["id"] or limits["level"] != local["level"]:
        raise ValueError("Seat policy belongs to another host or level")

    def quantity(value):
        if type(value) is int and value >= 0:
            return value
        if isinstance(value, str) and re.fullmatch(r"[1-9][0-9]{0,8}[KMG]", value):
            return int(value[:-1]) * 1024 ** ("KMG".index(value[-1]) + 1)
        raise ValueError("Invalid workspace ceiling")

    requested = limits["workspaces"]
    ceiling = local["workspaces"]
    for key, maximum in {"max": ceiling["max"], **ceiling["each"]}.items():
        value = requested["max"] if key == "max" else requested["each"][key]
        if type(value) is not type(maximum) or quantity(value) > quantity(maximum):
            raise ValueError("Seat policy exceeds the host file for " + key)
    return policy


def provision(root, directory, person, name, uid, port, policy, call=run):
    if not re.fullmatch(r"[a-z][a-z0-9_]{0,24}", name) or not 1000 <= uid < 60000:
        raise ValueError("Use a local login name and a dedicated UID between 1000 and 59999")
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", person):
        raise ValueError("Invalid relay person ID")
    limits = policy["limits"]
    if limits["level"] != "staff":
        raise ValueError("Workspace seats require a staff host")
    if not 20000 <= port <= 29999:
        raise ValueError("Choose a dedicated seat port between 20000 and 29999")
    host_id = limits["id"]
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", host_id):
        raise ValueError("Invalid pool host ID")
    each = limits["workspaces"]["each"]
    homes = root / HOMES[1:]
    if not mounted(call, root / IMAGE[1:], homes):
        raise ValueError("Mount the quota filesystem first")
    home = homes / name
    file = directory / "seats.json"
    seats = json.loads(file.read_text()) if file.exists() else []
    record = dict(person=person, name=name, uid=uid, project=uid, port=port)
    existing = next((s for s in seats if s["person"] == person), None)
    account = call("getent", "passwd", name, optional=True)
    if existing is None:
        if (len(seats) >= limits["workspaces"]["max"] or home.exists() or home.is_symlink()
            or account or call("getent", "passwd", str(uid), optional=True)
            or any(s["uid"] == uid or s["name"] == name or s["port"] == port for s in seats)):
            raise ValueError("Seat capacity or identity conflict")
        existing = dict(record, ready=False)
        seats.append(existing)
        save(file, seats)
    if any(existing[k] != v for k, v in record.items()) or home.is_symlink():
        raise ValueError("Seat identity conflict")
    if account and (account.split(":")[2] != str(uid) or account.split(":")[5] != str(home)):
        raise ValueError("Account does not match the reserved seat")
    if not account and call("getent", "passwd", str(uid), optional=True):
        raise ValueError("UID already assigned")
    home.mkdir(mode=0o700, exist_ok=True)
    if not existing["ready"]:
        call("xfs_quota", "-x", "-c", f"project -s -p {home} {uid}", str(homes))
    call("xfs_quota", "-x", "-c", f"limit -p bhard={each['disk']} {uid}", str(homes))
    drop = root / f"etc/systemd/system/user-{uid}.slice.d"
    drop.mkdir(parents=True, exist_ok=True)
    settings = (f"[Slice]\nCPUQuota={each['cpu'] * 100}%\nMemoryLow={each['memory_floor']}\n"
                f"MemoryMax={each['memory_max']}\nTasksMax={each['tasks']}\n"
                f"SocketBindAllow=tcp:{port}\nSocketBindDeny=tcp:20000-29999\n")
    (drop / "60-banneret.conf").write_text(settings)
    if not account:
        call("useradd", "-M", "-u", str(uid), "-d", str(home), "-s", "/bin/bash", name)
    call("chown", f"{name}:", str(home))
    unit = f"banneret-seat-{uid}.service"
    settings = (f"[Unit]\nDescription=Banneret Hub for {name}\nRequiresMountsFor={HOMES}\n"
                f"[Service]\nType=exec\nUser={name}\nSlice=user-{uid}.slice\nUMask=0077\n"
                f"WorkingDirectory={HOMES}/{name}\nEnvironment=HOME={HOMES}/{name}\n"
                f"Environment=BANNERET_POOL_HOST_ID={host_id}\n"
                f"ExecStart=/usr/local/bin/banneret serve --host 127.0.0.1 --port {port}\n"
                "StandardOutput=null\n"
                "ExecStartPost=/usr/bin/curl --noproxy * --fail --silent --output /dev/null "
                "--retry 30 --retry-delay 1 --retry-connrefused --max-time 2 "
                f"http://127.0.0.1:{port}/.well-known/t3/environment\n"
                "Restart=on-failure\n[Install]\nWantedBy=multi-user.target\n")
    (drop.parent / unit).write_text(settings)
    call("systemctl", "daemon-reload")
    call("systemctl", "enable", "--now", unit)
    existing["ready"] = True
    save(file, seats)
