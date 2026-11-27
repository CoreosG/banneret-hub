"""Host credential and signed relay calls."""
import base64
import json
import os
import platform
import tempfile
import time
from datetime import datetime, timezone
from urllib import request
from urllib.parse import urlsplit

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def utc():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def save(path, value):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False, mode="w") as out:
        json.dump(value, out)
        out.flush()
        os.fsync(out.fileno())
    os.replace(out.name, path)


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def post(state, path, body, enrolled=False):
    origin = urlsplit(state["origin"])
    if (origin.scheme != "https" and not (origin.scheme == "http" and origin.hostname in
            ("localhost", "127.0.0.1", "::1"))) or origin.path or origin.query or origin.fragment or origin.username:
        raise ValueError("Use an HTTPS relay origin, or HTTP loopback for tests")
    target = "/relay/v1/pool/hosts/" + path
    data = json.dumps(body, separators=(",", ":")).encode()
    counter = str(time.time_ns() // 1000) if enrolled else "0"
    device = state["machineId"] if enrolled else ""
    sent = utc()
    key = Ed25519PrivateKey.from_private_bytes(base64.b64decode(state["key"]))
    message = f"relay/v1\nPOST\n{target}\n{device}\n{counter}\n{sent}\n".encode() + data
    headers = {"Content-Type": "application/json", "X-Banneret-Counter": counter,
               "X-Banneret-Sent-At": sent, "X-Banneret-Signature": base64.b64encode(key.sign(message)).decode()}
    if enrolled:
        headers.update({"X-Banneret-Device": device, "Authorization": "Bearer " + state["token"]})
    req = request.Request(state["origin"] + target, data=data, headers=headers)
    with request.build_opener(NoRedirect).open(req, timeout=15) as response:
        return json.load(response)


def join(file, origin, host, version):
    if file.exists():
        state = json.loads(file.read_text())
        if (origin, host) != (state["origin"], state["host"]):
            raise ValueError("Credential belongs to another host or relay")
        if "token" in state:
            return
    else:
        key = Ed25519PrivateKey.generate()
        seed = key.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw,
                                 serialization.NoEncryption())
        public = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        state = dict(origin=origin, host=host, key=base64.b64encode(seed).decode())
        start = post(state, "enroll/start", dict(publicKey=base64.b64encode(public).decode(),
                     machine=dict(environmentId=host, label=host, kind="server", hostname=platform.node(),
                                  os=platform.system(), hubVersion=version, policyFingerprint=None,
                                  sandbox=dict(enabled=False, image=None))))
        state["pairing"] = start
        save(file, state)
    pairing = state["pairing"]
    print("Founder confirmation:", pairing["browserUrl"], pairing["confirmCode"], flush=True)
    while True:
        reply = post(state, "enroll/poll", {"pairingId": pairing["pairingId"]})
        if reply["state"] == "approved":
            state.update(token=reply["token"], machineId=reply["machineId"])
            del state["pairing"]
            save(file, state)
            return
        if reply["state"] not in ("pending", "awaiting_approval"):
            file.unlink()
            raise ValueError("Pairing " + reply["state"])
        time.sleep(max(0.1, reply["retryAfterMs"] / 1000))
