import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location(
    'fail2ban_metrics', Path(__file__).parents[1] / 'roles/host_security/files/fail2ban-metrics.py')
metrics = importlib.util.module_from_spec(spec)
spec.loader.exec_module(metrics)

STATUS = '''Status for the jail: sshd
|- Filter
|  |- Currently failed: 2
|  `- Total failed: 17
`- Actions
   |- Currently banned: 1
   |- Total banned: 4
   `- Banned IP list: 192.0.2.123
'''


class Fail2banMetricsTests(unittest.TestCase):
    def test_publishes_readable_counters_without_ip_labels(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'fail2ban.prom'
            with patch.object(metrics.subprocess, 'run', return_value=Mock(stdout=STATUS)):
                self.assertEqual(metrics.collect(target), 1)
            content = target.read_text()
            self.assertIn('fail2ban_banned_total{jail="sshd"} 4', content)
            self.assertIn('fail2ban_currently_failed{jail="sshd"} 2', content)
            self.assertIn('fail2ban_up 1', content)
            self.assertNotIn('192.0.2.123', content)
            self.assertEqual(target.stat().st_mode & 0o777, 0o644)

    def test_errors_replace_old_success_without_publishing_stale_counters(self):
        failures = [
            subprocess.CalledProcessError(1, 'fail2ban-client'),
            subprocess.TimeoutExpired('fail2ban-client', 10),
            OSError('client unavailable'),
        ]
        for failure in failures:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                target = Path(directory) / 'fail2ban.prom'
                target.write_text('fail2ban_up 1\nfail2ban_banned_total{jail="sshd"} 4\n')
                with patch.object(metrics.subprocess, 'run', side_effect=failure):
                    self.assertEqual(metrics.collect(target), 0)
                self.assertIn('fail2ban_up 0', target.read_text())
                self.assertNotIn('fail2ban_banned_total', target.read_text())
                self.assertEqual(list(Path(directory).iterdir()), [target])

    def test_partial_status_does_not_report_healthy(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'fail2ban.prom'
            with patch.object(metrics.subprocess, 'run', return_value=Mock(stdout='Currently failed: 2')):
                self.assertEqual(metrics.collect(target), 0)
            self.assertIn('fail2ban_up 0', target.read_text())
            self.assertNotIn('fail2ban_currently_failed', target.read_text())
