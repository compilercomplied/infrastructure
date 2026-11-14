#!/usr/bin/python3
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time


TARGET = Path('/var/lib/node_exporter/textfile_collector/fail2ban.prom')
COUNTERS = (
    ('Currently failed', 'fail2ban_currently_failed', 'gauge'),
    ('Total failed', 'fail2ban_failed_total', 'counter'),
    ('Currently banned', 'fail2ban_currently_banned', 'gauge'),
    ('Total banned', 'fail2ban_banned_total', 'counter'),
)


def render_status(status):
    lines = []
    for label, metric, kind in COUNTERS:
        match = re.search(r'\b' + re.escape(label) + r':\s*(\d+)\b', status)
        if not match:
            raise ValueError(f'Missing Fail2ban counter: {label}')
        lines.extend([
            f'# HELP {metric} SSH jail {label.lower()}. Totals reset when the jail restarts.',
            f'# TYPE {metric} {kind}',
            f'{metric}{{jail="sshd"}} {match.group(1)}',
        ])
    return lines


def collect(target=TARGET):
    success = 0
    lines = []
    try:
        result = subprocess.run(
            ['/usr/bin/fail2ban-client', 'status', 'sshd'],
            capture_output=True, text=True, check=True, timeout=10,
            env={**os.environ, 'LC_ALL': 'C'},
        )
        lines = render_status(result.stdout)
        success = 1
    except (subprocess.SubprocessError, ValueError, OSError) as error:
        print(f'Fail2ban metrics collection failed: {error}', flush=True)
    lines.extend([
        '# HELP fail2ban_up Whether the SSH jail counters were collected successfully.',
        '# TYPE fail2ban_up gauge',
        f'fail2ban_up {success}',
        '# HELP fail2ban_metrics_timestamp_seconds Time of the last collection attempt.',
        '# TYPE fail2ban_metrics_timestamp_seconds gauge',
        f'fail2ban_metrics_timestamp_seconds {time.time():.0f}',
    ])
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', dir=target.parent, suffix='.tmp', delete=False) as output:
            temporary = Path(output.name)
            os.fchmod(output.fileno(), 0o644)
            output.write('\n'.join(lines) + '\n')
        os.replace(temporary, target)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return success


if __name__ == '__main__':
    raise SystemExit(0 if collect() else 1)
