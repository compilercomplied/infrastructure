# Host maintenance and recovery

Host provisioning runs outside k3s because restarting k3s also interrupts the CI
runner. A green provisioning workflow proves the work was queued, not that it
finished. Check `journalctl -u host-provision-<commit>` for completion before
assuming a merged host change is active. Deployment credentials and queueing
mechanics belong to [the workflow](../.forgejo/workflows/host-provision.yaml).

## Reboots trade availability for maintenance

A single node cannot drain workloads to a replacement. Shutdown budgets give
processes time to stop; they do not guarantee arbitrary work completes. The
maintenance idle check covers Kubernetes Jobs and Forgejo job containers, not
every active application or coding-agent turn. It also does not prevent new
work from starting between the check and shutdown.

APT can restart services or leave partial upgrades after failure. Blocking a
reboot cannot undo those changes. The host follows Debian's package stream;
upgrading host packages does not upgrade the separately installed k3s binary.
Use [role defaults](../ansible/roles/host_maintenance/defaults/main.yml) for the
schedule and budgets instead of duplicating them in this document.

## Investigate before retrying

An unverified reboot attempt blocks later automatic maintenance to avoid a reboot
loop. Before clearing that state, determine whether the expected kernel booted
and whether k3s and stateful applications recovered. Keep the recorded attempt as
incident evidence; clearing it does not repair the underlying failure.

Read-only diagnostics on the host:

```sh
systemctl list-timers host-maintenance.timer
journalctl -u host-maintenance -u host-maintenance-verify
cat /var/lib/host-maintenance/state.json
uname -r
```

The [maintenance implementation](../ansible/roles/host_maintenance/files/host-maintenance.py)
owns the checks and state transitions. Ad-hoc repairs require the explicit
permission specified in [AGENTS.md](../AGENTS.md). Disabling future timer runs
does not cancel maintenance already in progress; disabling reboots does not stop
package upgrades.

## Evidence limits

Local tests check safety decisions and rendered configuration, not bootloader or
application recovery. Validate an authorized real reboot and restoration before
relying on them. Initial provisioning can itself restart k3s and logind, so it
needs a maintenance window too.

Monitoring on the same node cannot report a host that never boots. External
availability monitoring is needed for that failure mode. An alert rule alone
also does not deliver notifications: its receiver must accept Alertmanager's
webhook format; a plain ntfy topic URL is not interchangeable.
