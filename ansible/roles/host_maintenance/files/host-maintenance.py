#!/usr/bin/python3
"""Host-local maintenance; failures never force a reboot or retry a failed boot."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import time

STATE = Path('/var/lib/host-maintenance/state.json')
CONFIG = Path('/etc/host-maintenance/config.json')
K3S = '/usr/local/bin/k3s'


def run(*args, timeout=60):
    return subprocess.run(args, check=True, text=True, stdout=subprocess.PIPE,
                          timeout=timeout).stdout.strip()


def kubectl(*args):
    return run(K3S, 'kubectl', '--request-timeout=30s', *args)


def atomic_write(path, content, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(content)
    temporary.chmod(mode)
    temporary.replace(path)


def persist(state, config):
    atomic_write(STATE, json.dumps(state, indent=2) + '\n')
    names = ('last_success_timestamp_seconds', 'last_attempt_timestamp_seconds',
             'update_success', 'reboot_pending', 'reboot_deferred',
             'boot_verification_failed')
    metrics = ''.join(f'host_maintenance_{name} {state.get(name, 0)}\n' for name in names)
    atomic_write(Path(config['metrics_directory']) / 'host_maintenance.prom', metrics, 0o644)


def boot_id():
    return Path('/proc/sys/kernel/random/boot_id').read_text().strip()


def target_kernel():
    image = Path('/vmlinuz').resolve(strict=True)
    release = image.name.removeprefix('vmlinuz-')
    if not image.name.startswith('vmlinuz-') or not Path('/lib/modules', release).is_dir():
        raise RuntimeError('Kernel image or modules are missing')
    if not Path('/boot', 'initrd.img-' + release).is_file():
        raise RuntimeError('Target kernel initramfs is missing')
    return release, image


def needs_reboot(release, image):
    # Package revisions can replace a kernel without changing uname's release string.
    boot_time = time.time() - float(Path('/proc/uptime').read_text().split()[0])
    return release != os.uname().release or image.stat().st_ctime > boot_time


def cluster_ready():
    nodes = json.loads(kubectl('get', 'nodes', '-o', 'json'))['items']
    if len(nodes) != 1:
        raise RuntimeError('Maintenance supports exactly one node')
    node = nodes[0]
    if node.get('status', {}).get('nodeInfo', {}).get('bootID') != boot_id():
        raise RuntimeError('Kubelet has not reported the current boot')
    if not any(c['type'] == 'Ready' and c['status'] == 'True'
               for c in node['status']['conditions']):
        raise RuntimeError('Node is not ready')
    return node['metadata']['name']


def busy_reasons():
    jobs = json.loads(kubectl('get', 'jobs', '-A', '-o', 'json'))['items']
    reasons = [f"job {j['metadata']['namespace']}/{j['metadata']['name']}"
               for j in jobs if j.get('status', {}).get('active', 0)]
    pods = json.loads(kubectl('get', 'pods', '-n', 'forgejo', '-o', 'json'))['items']
    for pod in pods:
        if not pod['metadata'].get('labels', {}).get('app', '').startswith(('forgejo-runner', 'forgejo-android-runner')):
            continue
        if pod['status'].get('phase') != 'Running':
            raise RuntimeError('Cannot inspect a Forgejo runner that is not running')
        if any(c['name'] == 'dind' for c in pod['spec']['containers']):
            containers = kubectl('exec', '-n', 'forgejo', pod['metadata']['name'],
                                 '-c', 'dind', '--', 'docker', 'ps', '-q')
            if containers:
                reasons.append('CI containers in ' + pod['metadata']['name'])
    return reasons


def wait_idle(config, deadline):
    while True:
        reasons = busy_reasons()
        if not reasons:
            return
        if time.monotonic() >= deadline:
            raise RuntimeError('Maintenance deferred: ' + ', '.join(reasons))
        print('Waiting for ' + ', '.join(reasons), flush=True)
        time.sleep(min(60, max(0, deadline - time.monotonic())))


def assert_shutdown_ready(config):
    node = cluster_ready()
    effective = json.loads(kubectl('get', '--raw', f'/api/v1/nodes/{node}/proxy/configz'))['kubeletconfig']
    expected = {
        'shutdownGracePeriod': config['shutdown_seconds'],
        'shutdownGracePeriodCriticalPods': config['critical_shutdown_seconds'],
    }
    for field, seconds in expected.items():
        if duration_seconds(effective.get(field, '0s')) < seconds:
            raise RuntimeError(f'Effective kubelet {field} is too short')
    delay = run('busctl', 'get-property', 'org.freedesktop.login1',
                '/org/freedesktop/login1', 'org.freedesktop.login1.Manager',
                'InhibitDelayMaxUSec')
    if int(delay.split()[1]) < config['shutdown_seconds'] * 1_000_000:
        raise RuntimeError('logind shutdown delay is too short')
    # A configured budget is insufficient if kubelet failed to acquire its inhibitor.
    inhibitors = run('systemd-inhibit', '--list', '--no-pager')
    if not any('kubelet' in line.lower() and 'shutdown' in line and 'delay' in line
               for line in inhibitors.splitlines()):
        raise RuntimeError('Kubelet shutdown inhibitor is missing')


def duration_seconds(value):
    parts = re.findall(r'(\d+(?:\.\d+)?)(h|m|s)', value)
    if ''.join(n + unit for n, unit in parts) != value:
        raise ValueError('Unsupported duration: ' + value)
    return sum(float(n) * {'h': 3600, 'm': 60, 's': 1}[unit] for n, unit in parts)


def assert_bootloader(release):
    # /vmlinuz alone does not prove GRUB will choose that image on the next boot.
    environment = run('grub-editenv', '/boot/grub/grubenv', 'list')
    if any(line.startswith('next_entry=') and line != 'next_entry='
           for line in environment.splitlines()):
        raise RuntimeError('GRUB has a one-shot boot override')
    grub = Path('/boot/grub/grub.cfg').read_text()
    first_linux = re.search(r'^\s*linux\s+\S*vmlinuz-([^\s]+)', grub, re.MULTILINE)
    if (not first_linux or first_linux[1] != release or 'set default="0"' not in grub
            or 'set default="${saved_entry}"' in grub):
        raise RuntimeError('GRUB first entry does not match target kernel')


def verify(state, config):
    pending = state.get('reboot_attempt')
    if not pending:
        persist(state, config)
        return
    if pending['boot_id'] == boot_id():
        raise RuntimeError('Reboot has not occurred; refusing another attempt')
    if pending['kernel'] != os.uname().release:
        raise RuntimeError('Booted an unexpected kernel; automatic reboot is blocked')
    deadline = time.monotonic() + config['verify_timeout_seconds']
    while True:
        try:
            cluster_ready()
            workloads = json.loads(kubectl('get', 'deployments,statefulsets', '-A', '-o', 'json'))['items']
            unavailable = [w['metadata']['name'] for w in workloads
                           if w.get('status', {}).get('readyReplicas', 0) < w['spec'].get('replicas', 1)]
            if unavailable:
                raise RuntimeError('Workloads not ready: ' + ', '.join(unavailable))
            break
        except (RuntimeError, subprocess.SubprocessError) as error:
            if time.monotonic() >= deadline:
                raise RuntimeError('Recovery timed out') from error
            time.sleep(15)
    state.pop('reboot_attempt')
    state.update(reboot_pending=0, reboot_deferred=0, boot_verification_failed=0)
    persist(state, config)


def update(state, config):
    state.update(last_attempt_timestamp_seconds=int(time.time()), update_success=0,
                 reboot_deferred=0)
    persist(state, config)
    if state.get('reboot_attempt') or state.get('boot_verification_failed'):
        raise RuntimeError('Previous reboot is unverified; inspect recovery before resuming')
    assert_shutdown_ready(config)
    deadline = time.monotonic() + config['busy_timeout_seconds']
    wait_idle(config, deadline)
    env = {**os.environ, 'DEBIAN_FRONTEND': 'noninteractive'}
    apt = ['apt-get', '-o', 'DPkg::Lock::Timeout=300', '-o', 'APT::Update::Error-Mode=any']
    subprocess.run([*apt, 'update'], check=True, env=env, timeout=1800)
    subprocess.run([*apt, '-y', '--with-new-pkgs', '--no-remove',
                    '-o', 'Dpkg::Options::=--force-confdef',
                    '-o', 'Dpkg::Options::=--force-confold', 'upgrade'],
                   check=True, env=env, timeout=5400)
    release, image = target_kernel()
    state.update(update_success=1, last_success_timestamp_seconds=int(time.time()),
                 reboot_pending=int(needs_reboot(release, image)))
    persist(state, config)
    if not state['reboot_pending'] or not config['reboot']:
        return
    # An update can outlast the idle window; never carry a reboot into daytime use.
    if time.monotonic() >= deadline:
        raise RuntimeError('Update exceeded the maintenance window; reboot deferred')
    wait_idle(config, deadline)
    assert_shutdown_ready(config)
    assert_bootloader(release)
    state['reboot_attempt'] = {'boot_id': boot_id(), 'kernel': release,
                               'timestamp': int(time.time())}
    persist(state, config)
    run('systemctl', 'reboot')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['update', 'verify'])
    args = parser.parse_args()
    config = json.loads(CONFIG.read_text())
    with open('/run/host-maintenance.lock', 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        state = json.loads(STATE.read_text()) if STATE.exists() else {}
        try:
            if args.action == 'verify':
                verify(state, config)
            else:
                update(state, config)
        except Exception as error:
            state["last_error"] = str(error)
            state['boot_verification_failed' if args.action == 'verify' else 'reboot_deferred'] = 1
            persist(state, config)
            raise


if __name__ == '__main__':
    main()
