import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location(
    'maintenance', Path(__file__).parents[1] / 'roles/host_maintenance/files/host-maintenance.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class MaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.config = {'reboot': True, 'busy_timeout_seconds': 3600,
                       'verify_timeout_seconds': 60, 'shutdown_seconds': 300,
                       'critical_shutdown_seconds': 30}

    def test_go_duration_parsing(self):
        self.assertEqual(m.duration_seconds('5m0s'), 300)
        self.assertEqual(m.duration_seconds('30s'), 30)
        with self.assertRaises(ValueError):
            m.duration_seconds('garbage')

    def test_active_backup_and_android_ci_defer(self):
        pod = {'metadata': {'name': 'android', 'labels': {'app': 'forgejo-android-runner'}},
               'status': {'phase': 'Running'}, 'spec': {'containers': [{'name': 'dind'}]}}
        with patch.object(m, 'kubectl', side_effect=[
            json.dumps({'items': [{'metadata': {'name': 'backup', 'namespace': 'selfhosted'},
                                  'status': {'active': 1}}]}),
            json.dumps({'items': [pod]}), 'container-id']):
            self.assertEqual(len(m.busy_reasons()), 2)

    def test_failed_ci_inspection_is_not_treated_as_idle(self):
        with patch.object(m, 'kubectl', side_effect=RuntimeError('API unavailable')):
            with self.assertRaises(RuntimeError):
                m.busy_reasons()

    def test_busy_deadline_does_not_force_reboot(self):
        with patch.object(m, 'busy_reasons', return_value=['backup']), \
             patch.object(m.time, 'monotonic', return_value=100), \
             patch.object(m, 'run') as command:
            with self.assertRaisesRegex(RuntimeError, 'deferred'):
                m.wait_idle(self.config, 99)
            command.assert_not_called()

    def test_previous_reboot_blocks_updates(self):
        with patch.object(m, 'persist'), patch.object(m.subprocess, 'run') as apt:
            with self.assertRaisesRegex(RuntimeError, 'unverified'):
                m.update({'reboot_attempt': {'kernel': 'old'}}, self.config)
            apt.assert_not_called()

    def test_failed_apt_never_reboots(self):
        with patch.object(m, 'persist'), patch.object(m, 'assert_shutdown_ready'), \
             patch.object(m, 'wait_idle'), \
             patch.object(m.subprocess, 'run', side_effect=m.subprocess.CalledProcessError(1, 'apt')), \
             patch.object(m, 'run') as command:
            with self.assertRaises(m.subprocess.CalledProcessError):
                m.update({}, self.config)
            command.assert_not_called()

    def test_unchanged_kernel_does_not_reboot(self):
        with patch.object(m, 'persist'), patch.object(m, 'assert_shutdown_ready'), \
             patch.object(m, 'wait_idle'), patch.object(m.subprocess, 'run'), \
             patch.object(m, 'target_kernel', return_value=('current', Path('/kernel'))), \
             patch.object(m, 'needs_reboot', return_value=False), patch.object(m, 'run') as command:
            state = {}
            m.update(state, self.config)
            self.assertEqual(state['update_success'], 1)
            command.assert_not_called()

    def test_new_kernel_records_attempt_before_reboot(self):
        with patch.object(m, 'persist') as save, patch.object(m, 'assert_shutdown_ready'), \
             patch.object(m, 'wait_idle'), patch.object(m.subprocess, 'run') as apt, \
             patch.object(m, 'target_kernel', return_value=('new', Path('/kernel'))), \
             patch.object(m, 'needs_reboot', return_value=True), \
             patch.object(m, 'assert_bootloader'), patch.object(m, 'boot_id', return_value='before'), \
             patch.object(m, 'run') as command:
            state = {}
            command.side_effect = lambda *a: self.assertEqual(state['reboot_attempt']['kernel'], 'new')
            m.update(state, self.config)
            command.assert_called_once_with('systemctl', 'reboot')
            self.assertGreaterEqual(save.call_count, 3)
            self.assertIn('--no-remove', apt.call_args_list[1].args[0])
            self.assertIn('--with-new-pkgs', apt.call_args_list[1].args[0])

    def test_disabled_reboot_still_updates(self):
        with patch.object(m, 'persist'), patch.object(m, 'assert_shutdown_ready'), \
             patch.object(m, 'wait_idle'), patch.object(m.subprocess, 'run'), \
             patch.object(m, 'target_kernel', return_value=('new', Path('/kernel'))), \
             patch.object(m, 'needs_reboot', return_value=True), patch.object(m, 'run') as command:
            state = {}
            m.update(state, {**self.config, 'reboot': False})
            self.assertEqual(state['reboot_pending'], 1)
            command.assert_not_called()

    def test_same_boot_and_kernel_fallback_are_blocked(self):
        state = {'reboot_attempt': {'boot_id': 'before', 'kernel': 'expected'}}
        with patch.object(m, 'boot_id', return_value='before'):
            with self.assertRaisesRegex(RuntimeError, 'not occurred'):
                m.verify(state, self.config)
        with patch.object(m, 'boot_id', return_value='after'):
            with self.assertRaisesRegex(RuntimeError, 'unexpected kernel'):
                m.verify(state, self.config)
        self.assertIn('reboot_attempt', state)

    def test_successful_recovery_clears_attempt(self):
        state = {'reboot_attempt': {'boot_id': 'before', 'kernel': m.os.uname().release}}
        with patch.object(m, 'boot_id', return_value='after'), \
             patch.object(m, 'cluster_ready'), patch.object(m, 'persist'), \
             patch.object(m, 'kubectl', return_value='{"items": []}'):
            m.verify(state, self.config)
        self.assertNotIn('reboot_attempt', state)
        self.assertEqual(state['boot_verification_failed'], 0)

    def test_kernel_replacement_with_same_release_requires_reboot(self):
        image = Mock()
        image.stat.return_value.st_ctime = 600
        with patch.object(m.time, 'time', return_value=1000), \
             patch.object(m.Path, 'read_text', return_value='500 0'):
            self.assertTrue(m.needs_reboot(m.os.uname().release, image))
            image.stat.return_value.st_ctime = 400
            self.assertFalse(m.needs_reboot(m.os.uname().release, image))

    def test_missing_shutdown_inhibitor_blocks_reboot(self):
        with patch.object(m, 'cluster_ready', return_value='node'), \
             patch.object(m, 'kubectl', return_value=json.dumps({'kubeletconfig': {
                 'shutdownGracePeriod': '5m0s', 'shutdownGracePeriodCriticalPods': '30s'}})), \
             patch.object(m, 'run', side_effect=['t 360000000', 'no inhibitors']):
            with self.assertRaisesRegex(RuntimeError, 'inhibitor is missing'):
                m.assert_shutdown_ready(self.config)

    def test_update_overruns_window_without_reboot(self):
        with patch.object(m, 'persist'), patch.object(m, 'assert_shutdown_ready'), \
             patch.object(m, 'wait_idle'), patch.object(m.subprocess, 'run'), \
             patch.object(m, 'target_kernel', return_value=('new', Path('/kernel'))), \
             patch.object(m, 'needs_reboot', return_value=True), \
             patch.object(m.time, 'monotonic', side_effect=[0, 4000]), \
             patch.object(m, 'run') as command:
            with self.assertRaisesRegex(RuntimeError, 'exceeded'):
                m.update({}, self.config)
            command.assert_not_called()

    def test_atomic_metrics_are_readable_without_root(self):
        with tempfile.TemporaryDirectory() as directory:
            config = {**self.config, 'metrics_directory': directory}
            with patch.object(m, 'STATE', Path(directory) / 'state.json'):
                m.persist({'update_success': 1}, config)
            metric = Path(directory) / 'host_maintenance.prom'
            self.assertIn('host_maintenance_update_success 1', metric.read_text())
            self.assertEqual(metric.stat().st_mode & 0o777, 0o644)
            self.assertFalse(list(Path(directory).glob('*.tmp')))


if __name__ == '__main__':
    unittest.main()
