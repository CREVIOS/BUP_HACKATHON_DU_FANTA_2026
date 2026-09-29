import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

class ProcessTests(unittest.TestCase):
    def test_bridge_timeout_is_bounded(self):
        from training.planner_bridge import PlannerBridge
        with tempfile.TemporaryDirectory() as d:
            executable=Path(d)/'stalled'
            executable.write_text('#!/bin/sh\nexec sleep 20\n');executable.chmod(0o700)
            self.assertIn('timeout',__import__('inspect').signature(PlannerBridge).parameters)
            bridge=PlannerBridge(executable,timeout=.05)
            start=time.monotonic()
            try:
                with self.assertRaises(TimeoutError):bridge.evaluate({})
            finally:bridge.close()
            self.assertLess(time.monotonic()-start,2)

    def test_timeout_stops_process_group(self):
        from training import sweep
        self.assertTrue(hasattr(sweep,'wait_job'),'process-group watchdog missing')
        with tempfile.TemporaryDirectory() as d:
            marker=Path(d)/'escaped'
            childcode='import time,pathlib;time.sleep(.8);pathlib.Path('+repr(str(marker))+').touch()'
            code='import subprocess,sys,time;subprocess.Popen([sys.executable,"-c",'+repr(childcode)+']);time.sleep(20)'
            child=subprocess.Popen([sys.executable,'-c',code],start_new_session=True)
            try:
                with self.assertRaises(subprocess.TimeoutExpired):sweep.wait_job(child,.1)
                time.sleep(1)
                self.assertFalse(marker.exists(),'orphan worker outlived timeout')
            finally:
                try:os.killpg(child.pid,9)
                except ProcessLookupError:pass
                child.wait()
