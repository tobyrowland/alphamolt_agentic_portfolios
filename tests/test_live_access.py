"""Who may open /live, when one of the two access reads fails.

Access is the OR of two grants: an operator flag (`profiles.live_access`) and
owning a `mode='live'` portfolio. They are independent by design — one is a
decision, the other a fact about what the user owns.

The first deploy got the failure case wrong, and the way it went wrong is the
reason these tests exist. Both reads sat in one try/catch. The page merged
before migration 089 ran, so `select live_access` errored on a column that did
not exist yet, the throw discarded the OWNERSHIP answer with it, and the
resolver denied. Every owner of a real live account — the only people the page
was for — got a 404 from their own console because of a flag that has nothing
to do with them.

The rule that fixes it has two halves, and both need pinning: a failed read
must not revoke the OTHER grant, and it must never itself be read as a yes.
"""
from __future__ import annotations

import json
import pathlib
import shutil
import subprocess
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
RUNNER = ROOT / "tests" / "ts_live_access_runner.mjs"


def _run_ts() -> dict:
    node = shutil.which("node")
    if node is None:
        raise unittest.SkipTest("node not available")
    proc = subprocess.run(
        [node, "--experimental-strip-types", str(RUNNER)],
        capture_output=True, text=True, cwd=ROOT,
    )
    if proc.returncode != 0:
        raise unittest.SkipTest(f"node cannot strip types: {proc.stderr[:300]}")
    return json.loads(proc.stdout)


class AccessRuleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        out = _run_ts()
        cls.rule = out["rule"]
        cls.degraded = out["degraded"]

    def test_either_grant_alone_is_enough(self):
        self.assertTrue(self.rule["flagOnly"])
        self.assertTrue(self.rule["ownershipOnly"])

    def test_neither_grant_is_no_access(self):
        self.assertFalse(self.rule["neither"])

    def test_both_grants_is_still_access(self):
        """An operator revoking the flag must not lock an owner out of their
        own account — the grants are ORed, never ANDed."""
        self.assertTrue(self.rule["both"])


class DegradedReadTests(unittest.TestCase):
    """`null` means the read failed, and it is not the same as `false`."""

    @classmethod
    def setUpClass(cls):
        cls.degraded = _run_ts()["degraded"]

    def test_an_unreadable_flag_does_not_revoke_ownership(self):
        """The exact production regression: migration 089 had not run yet."""
        self.assertTrue(self.degraded["flagUnreadableButOwnsOne"])

    def test_an_unreadable_ownership_count_does_not_revoke_the_flag(self):
        """The mirror image — same rule, other direction."""
        self.assertTrue(self.degraded["ownershipUnreadableButFlagged"])

    def test_a_failed_read_is_never_itself_a_grant(self):
        """The security half. Independence must not become permissiveness:
        a read that failed says nothing, so on its own it denies."""
        self.assertFalse(self.degraded["flagUnreadableAndOwnsNone"])
        self.assertFalse(self.degraded["ownershipUnreadableUnflagged"])

    def test_both_reads_failing_denies(self):
        self.assertFalse(self.degraded["bothUnreadable"])


if __name__ == "__main__":
    unittest.main()
