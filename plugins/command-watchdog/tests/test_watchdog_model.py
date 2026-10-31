import os, sys, unittest
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "hooks"))
from watchdog_model import KillReason, FiredCheck, Outcome, LoopKind


class ModelTests(unittest.TestCase):
    def test_kill_reasons_match_code_names(self):
        self.assertEqual({r.value for r in KillReason},
                         {"idle", "poll-idle", "target-gone", "max-runtime", "orphaned"})

    def test_fired_checks(self):
        self.assertEqual({f.value for f in FiredCheck}, {"idle", "max_runtime", "poll_cap", "none"})

    def test_outcomes(self):
        self.assertEqual({o.value for o in Outcome}, {"success", "failed", "killed"})

    def test_loop_kinds(self):
        self.assertEqual({k.value for k in LoopKind}, {"none", "targeted", "untargeted"})


if __name__ == "__main__":
    unittest.main()
