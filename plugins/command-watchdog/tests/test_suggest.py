import os, sys, unittest
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "hooks"))
from suggest import CheckInput, round_up, suggest_check


def inp(**kw):
    base = dict(name="idle", configured=300, successes=10, maximum=30.0, kills=0, invocations=12,
                poll=5, acceptable_kill_percent=25)
    base.update(kw)
    return CheckInput(**base)


def values(result):
    return {o.name: o.value for o in result.options}


class RoundingTests(unittest.TestCase):
    def test_round_up(self):
        self.assertEqual(round_up(0), 0)
        self.assertEqual(round_up(1), 5)
        self.assertEqual(round_up(31), 35)
        self.assertEqual(round_up(30), 30)
        self.assertEqual(round_up(61), 90)


class SuggestTests(unittest.TestCase):
    def test_tighten_example(self):
        result = suggest_check(inp())
        self.assertEqual(result.trigger, "tighten")
        self.assertEqual(values(result), {"tight": 40, "medium": 45, "long": 90})
        self.assertTrue([o for o in result.options if o.name == "tight"][0].recommended)

    def test_loosen_when_kill_rate_high(self):
        result = suggest_check(inp(maximum=280.0, successes=7, kills=3, invocations=10))
        self.assertEqual(result.trigger, "loosen")
        self.assertEqual(values(result)["medium"], 600)
        self.assertEqual(values(result)["long"], 900)
        self.assertTrue([o for o in result.options if o.name == "medium"][0].recommended)

    def test_loosen_when_successes_close_to_limit(self):
        self.assertEqual(suggest_check(inp(maximum=240.0, kills=0)).trigger, "loosen")

    def test_no_successes_with_numeric_limit_uses_limit(self):
        result = suggest_check(inp(successes=0, maximum=0.0, kills=5, invocations=5, configured=600))
        self.assertEqual(values(result)["medium"], 1200)
        self.assertEqual(values(result)["long"], 1800)
        self.assertEqual(result.confidence, "no successful runs yet")

    def test_no_invocations_gives_no_options(self):
        result = suggest_check(inp(configured=None, successes=0, maximum=0.0, invocations=0))
        self.assertEqual(result.confidence, "no runs yet")
        self.assertEqual(result.options, ())

    def test_off_with_no_successes_is_floor(self):
        # C = off, N = 0, but there were runs (all killed): every option is the floor.
        result = suggest_check(inp(configured=None, successes=0, maximum=0.0, kills=4, invocations=4, poll=5))
        self.assertEqual(result.confidence, "no successful runs yet")
        floor = round_up(max(5, 2 * 5))
        self.assertEqual(values(result), {"tight": floor, "medium": floor, "long": floor})
        self.assertTrue(all(o.confidence == "no successful runs yet" for o in result.options))

    def test_zero_maximum_yields_floor_not_zero(self):
        result = suggest_check(inp(maximum=0.0, successes=4, invocations=4, poll=1))
        self.assertGreaterEqual(values(result)["tight"], 5)

    def test_low_confidence_below_three_successes(self):
        self.assertEqual(suggest_check(inp(successes=2, invocations=2)).confidence, "low confidence")

    def test_acceptable_percent_threshold(self):
        self.assertIsNone(suggest_check(inp(maximum=150.0, successes=7, kills=3, invocations=10,
                                            acceptable_kill_percent=40)).trigger)
        self.assertEqual(suggest_check(inp(maximum=150.0, successes=7, kills=3, invocations=10,
                                           acceptable_kill_percent=25)).trigger, "loosen")

    def test_kill_percent_exactly_at_threshold_does_not_loosen(self):
        # K% = 3/12 = 25%, equal to the acceptable percent: the trigger is strictly greater-than.
        result = suggest_check(inp(maximum=150.0, successes=9, kills=3, invocations=12, acceptable_kill_percent=25))
        self.assertIsNone(result.trigger)

    def test_fixtures_are_coherent(self):
        base = inp()
        self.assertLessEqual(base.successes + base.kills, base.invocations)


if __name__ == "__main__":
    unittest.main()
