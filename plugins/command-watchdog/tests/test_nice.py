"""Priority tests for command-watchdog.py.

Run: /usr/bin/python3 -m unittest discover -s plugins/command-watchdog/tests -v
"""
import os
import subprocess
import unittest

WATCHDOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "hooks", "command-watchdog.py")


def nice_of(cmd, **env):
    r = subprocess.run(
        ["/usr/bin/python3", WATCHDOG, cmd],
        capture_output=True, text=True, env=dict(os.environ, **env), timeout=30,
    )
    return [int(x) for x in r.stdout.split()]


class NiceTests(unittest.TestCase):
    def test_child_and_descendants_default_to_lowest_priority(self):
        self.assertEqual(nice_of('ps -o nice= -p $$; sh -c "ps -o nice= -p \\$\\$"'), [19, 19])

    def test_override(self):
        self.assertEqual(nice_of("ps -o nice= -p $$", WATCHDOG_NICE="5"),
                         [max(os.getpriority(os.PRIO_PROCESS, 0), 5)])

    def test_zero_leaves_priority_unchanged(self):
        self.assertEqual(nice_of("ps -o nice= -p $$", WATCHDOG_NICE="0"), [os.getpriority(os.PRIO_PROCESS, 0)])


if __name__ == "__main__":
    unittest.main()
