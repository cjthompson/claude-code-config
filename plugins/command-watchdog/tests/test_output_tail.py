import importlib.util, os, subprocess, sys, threading, unittest
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "hooks"))
from output_tail import OutputTail

WATCHDOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "hooks", "command-watchdog.py")
spec = importlib.util.spec_from_file_location("command_watchdog", WATCHDOG)
cw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cw)


def supervise_shell(script, run):
    """Run `script` under cw.supervise with its output sent to /dev/null; return the exit code.

    The run is passed explicitly; no module-level state is set."""
    r_fd, w_fd = os.pipe()
    proc = subprocess.Popen(["sh", "-c", script], stdout=w_fd, stderr=w_fd, start_new_session=True)
    os.close(w_fd)
    saved, devnull = os.dup(1), os.open(os.devnull, os.O_WRONLY)
    try:
        os.dup2(devnull, 1)
        return cw.supervise(script, proc, proc.pid, r_fd, run)
    finally:
        os.dup2(saved, 1)
        os.close(saved)
        os.close(devnull)
        os.close(r_fd)


class OutputTailTests(unittest.TestCase):
    def test_splits_lines_across_chunks(self):
        tail = OutputTail()
        tail.feed(b"ab", 0)
        tail.feed(b"c\nde", 1)
        tail.feed(b"f\n", 2)
        self.assertEqual([line for _, line in tail.lines()], ["abc", "def"])

    def test_keeps_last_twenty(self):
        tail = OutputTail()
        for i in range(25):
            tail.feed("line{}\n".format(i).encode(), i)
        lines = [line for _, line in tail.lines()]
        self.assertEqual(len(lines), 20)
        self.assertEqual(lines[0], "line5")
        self.assertEqual(lines[-1], "line24")

    def test_truncates_long_lines_and_flushes_partial(self):
        tail = OutputTail()
        tail.feed(b"x" * 5000, 0)
        tail.flush(1)
        lines = tail.lines()
        self.assertEqual(len(lines[0][1]), 4096)

    def test_one_large_chunk_keeps_last_twenty(self):
        tail = OutputTail()
        tail.feed("".join("row{}\n".format(i) for i in range(100000)).encode(), 5)
        lines = tail.lines()
        self.assertEqual([line for _, line in lines], ["row{}".format(i) for i in range(99980, 100000)])
        self.assertTrue(all(ts.startswith("1970-01-01T00:00:05") for ts, _ in lines))

    def test_invalid_bytes_do_not_raise(self):
        tail = OutputTail()
        tail.feed(b"\xff\xfe bad\n", 0)
        self.assertIn("bad", tail.lines()[0][1])

    def test_timestamps_are_utc_iso(self):
        tail = OutputTail()
        tail.feed(b"hi\n", 0)
        self.assertTrue(tail.lines()[0][0].startswith("1970-01-01T00:00:00"))

    def test_every_method_waits_while_another_thread_holds_the_lock(self):
        # The reader thread can still be feeding when the main thread flushes or reads the tail.
        calls = {"feed": lambda t: t.feed(b"x\n", 0), "flush": lambda t: t.flush(0), "lines": lambda t: t.lines()}
        for name, call in calls.items():
            with self.subTest(method=name):
                tail = OutputTail()
                done = threading.Event()

                def worker():
                    call(tail)
                    done.set()

                with tail._lock:
                    threading.Thread(target=worker, daemon=True).start()
                    self.assertFalse(done.wait(0.2))
                self.assertTrue(done.wait(2))


class SuperviseRecordingTests(unittest.TestCase):
    def test_records_max_silence_and_tail(self):
        run = cw.RunState("x", False)
        code = supervise_shell("echo first; sleep 2.5; echo second", run)
        self.assertEqual(code, 0)
        self.assertGreaterEqual(run.max_silence, 2.0)
        self.assertEqual([line for _, line in run.tail.lines()], ["first", "second"])

    def test_trailing_silence_counts(self):
        run = cw.RunState("x", False)
        supervise_shell("sleep 2", run)
        self.assertGreaterEqual(run.max_silence, 1.9)
        # no_output_time is the silence at exit: the trailing gap, which here is the whole run.
        self.assertGreaterEqual(run.no_output_time, 1.9)
        self.assertEqual(run.no_output_time, run.max_silence)

    def test_no_output_time_is_only_the_trailing_gap(self):
        run = cw.RunState("x", False)
        supervise_shell("sleep 2.5; echo done", run)
        self.assertGreaterEqual(run.max_silence, 2.0)
        self.assertLess(run.no_output_time, run.max_silence)

    def test_cpu_time_recorded_for_cpu_bound_command(self):
        run = cw.RunState("x", False)
        code = supervise_shell("i=0; while [ $i -lt 200000 ]; do i=$((i+1)); done", run)
        self.assertEqual(code, 0)
        print("measured cpu_time={:.3f}".format(run.cpu_time), file=sys.stderr)
        self.assertGreater(run.cpu_time, 0.05)

    def test_works_without_a_run(self):
        self.assertEqual(supervise_shell("echo hi", None), 0)

    def test_tail_failure_does_not_break_output_or_exit(self):
        class Broken:
            def feed(self, chunk, now):
                raise RuntimeError("boom")

            def flush(self, now):
                raise RuntimeError("boom")

        run = cw.RunState("x", False)
        run.tail = Broken()
        self.assertEqual(supervise_shell("echo hi; exit 3", run), 3)


if __name__ == "__main__":
    unittest.main()
