import base64
import io
import json
import tempfile
import unittest
from pathlib import Path
from urllib.error import HTTPError
from unittest.mock import Mock

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from sandbox import Bookings


class SandboxTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.runtime = Mock()
        self.runtime.machine.return_value = "sandbox-machine"
        self.report = Mock(return_value={"endsAt": "2030-01-01T01:00:00Z"})
        self.digest = "sha256:" + "a"*64
        self.policy = {"limits":{"id":"dev", "sandbox_slots":{"small":1}}, "sizes":{"small":{"cpu":1,"disk":"1G","memory":"1G"}}}
        cfg = dict(origin="https://relay.example", **self.policy, runner=dict(time_limit="1h", idle_limit="5m",
                                                                            images={self.digest:"example/image"}))
        self.jobs = Bookings(Path(directory.name), cfg, self.runtime, self.report, "boot", now=lambda:1)
        body = json.dumps(dict(hostId="dev", size="small", image=self.digest)).encode()
        key = Ed25519PrivateKey.generate()
        header = b"relay/v1\nPOST\n/relay/v1/pool/sandboxes\nm1\n1\ntime\n"
        b64 = lambda data: base64.b64encode(data).decode()
        self.offer = dict(id="sandbox", offerId="first", machineId="m1", personId="p1", deadline="2030-01-01T00:00:00Z",
                          counter="1", sentAt="time", bodyBase64=b64(body), signature=b64(key.sign(header+body)),
                          publicKey=b64(key.public_key().public_bytes(serialization.Encoding.Raw,serialization.PublicFormat.Raw)))
        self.seats = [dict(person="p1", name="alice", uid=1234)]

    def accept(self):
        self.jobs.accept(self.offer, "small", self.policy, self.seats)
        return next(iter(self.jobs.jobs))

    def test_verify_before_start(self):
        self.offer["counter"]="2"
        with self.assertRaises(InvalidSignature):
            self.accept()
        self.assertFalse(self.jobs.jobs)
        self.runtime.start.assert_not_called()

    def test_cancel_extend_and_verified_cleanup(self):
        key=self.accept()
        self.jobs.step(key, [])
        self.assertEqual(self.jobs.jobs[key]["phase"],"running")
        target=dict(sandboxId="sandbox", offerId="first")
        self.jobs.step(key,[dict(target,action="extend",endsAt="2030-01-01T02:00:00Z")])
        self.assertEqual(self.report.call_args.args[1]["endsAt"],"2030-01-01T02:00:00Z")
        self.jobs.step(key,[dict(target,action="cancel")])
        self.assertFalse(self.jobs.jobs)
        self.runtime.clean.assert_called_once()
        self.assertEqual([call.args[1]["state"] for call in self.report.call_args_list],
                         ["starting","running","running","ending","ended"])

    def test_reboot_and_cleanup_failure_hold_slot(self):
        key=self.accept()
        self.jobs.step(key,[])
        self.jobs.boot="next-boot"
        self.runtime.clean.side_effect=RuntimeError()
        self.jobs.step(key,[])
        self.assertEqual(self.report.call_args.args[1]["reason"],"host_restarted")
        self.assertEqual(self.report.call_args.args[1]["state"],"cleanup_failed")
        facts={"contention":{"freeSlots":{}}}
        self.jobs.facts(facts,{"small":1,"large":1})
        self.assertEqual(facts["contention"]["freeSlots"],{"small":0,"large":1})
        self.runtime.clean.side_effect=None
        self.jobs.retry_cleanup("sandbox","first")
        self.assertFalse(self.jobs.jobs)
        self.assertEqual(self.report.call_args.args[1]["state"],"ended")

    def test_missing_account_does_not_block_the_line(self):
        self.seats=[]
        self.jobs.step(self.accept(),[])
        self.assertFalse(self.jobs.jobs)
        self.runtime.start.assert_not_called()
        self.runtime.clean.assert_not_called()
        self.assertEqual(self.report.call_args.args[1]["reason"],"member_account_missing")

    def test_idle_timeout_is_local(self):
        key=self.accept()
        self.jobs.step(key,[])
        self.runtime.has_work.return_value=False
        self.jobs.now=lambda:302
        self.jobs.step(key,[])
        self.assertEqual(self.report.call_args.args[1]["reason"],"idle_limit")
        self.assertFalse(self.jobs.jobs)

    def test_stale_start_allows_reoffer(self):
        key=self.accept()
        self.report.side_effect=HTTPError("",409,"conflict",{},io.BytesIO(b'{"current":{"sandboxId":"sandbox","state":"waiting"}}'))
        self.jobs.step(key,[])
        self.runtime.start.assert_not_called()
        self.assertFalse(self.jobs.jobs)
        self.offer["offerId"]="second"
        self.assertNotEqual(key,self.accept())


if __name__=="__main__":
    unittest.main()
