# Host updates and graceful reboots

Ansible owns the Debian host configuration. Pulumi owns workload termination
budgets, node-exporter integration, and Prometheus alerts. No CVE classifier or
Renovate kernel pin is involved: the host follows the latest packages available
in Debian `testing`, not the latest upstream kernel. This does not upgrade the
separately installed k3s binary.

## Daily behavior

`host-maintenance.timer` starts at 06:00 Europe/Madrid, including daylight-saving
changes. Missed runs do not catch up during daytime. The host-local service:

1. Checks the effective kubelet shutdown configuration, logind delay, and kubelet
   inhibitor. An unreachable API or missing safety configuration blocks maintenance.
2. Waits up to one hour for active Kubernetes Jobs and Docker containers inside
   both Forgejo runners to finish. Failed inspection is an error, not an idle result.
3. Refreshes APT metadata and upgrades packages, allowing new dependencies but no
   removals. APT lock waits are bounded. Existing local configuration is retained
   on unresolved conffile conflicts; inspect the journal for package notices.
4. Checks `/vmlinuz`, modules, and initramfs. A different kernel release or an
   image replaced since boot requires activation. The latter catches package
   revisions that preserve the same `uname -r` value.
5. Rechecks running work and the shutdown safeguards, and verifies that GRUB's
   first kernel matches the target with no one-shot override. If the one-hour
   maintenance window has elapsed, reboot is deferred until the next daily run.
6. Records the expected kernel and boot ID durably before requesting a normal
   systemd reboot. The previous kernel is retained; there is no autoremove.

A second host-local service runs at boot. Following a recorded reboot attempt it
checks the kernel, a fresh kubelet boot ID, node readiness, and desired Deployment
and StatefulSet ready replicas, for up to 15 minutes. Failure preserves the attempt
and blocks subsequent automatic updates/reboots. There is no automatic rollback
or retry loop. A failed reboot request is also blocked until investigated.

The five-minute node shutdown budget reserves 270 seconds for ordinary pods and
30 seconds for critical pods. Shared app pods receive 60 seconds, shared databases
120 seconds, and game servers and CI runners 180 seconds. The game images' normal
signal handlers perform their shutdown/save; no guessed save commands are injected.
Forgejo runners wait up to 150 seconds, with DinD kept alive for 160 seconds by a
pre-stop hook. Application-specific behavior still needs a controlled reboot test.

These are bounded shutdown windows, not a guarantee arbitrary tasks finish. The
idle checks do not pause Forgejo scheduling or CronJobs: work can start between the
last check and shutdown. A newly started CI job has the runner grace window, not
an unlimited completion deadline. On this single-node cluster there is downtime;
we do not drain pods onto a nonexistent replacement node.

Ordinary package updates can restart host services. An APT failure may leave some
packages upgraded; it prevents our reboot but cannot undo package maintainer scripts.
The role disables unattended-upgrades' independent auto-upgrade/reboot policy so
this workflow owns the schedule. It also overrides its shorter logind shutdown delay.

## Configuration and deployment

Override defaults from `ansible/roles/host_maintenance/defaults/main.yml` in
`ansible/playbooks/group_vars/cluster.yml`:

```yaml
host_maintenance_enabled: true
host_maintenance_schedule: '*-*-* 06:00:00 Europe/Madrid'
host_maintenance_reboot: true
host_maintenance_busy_timeout_seconds: 3600
host_maintenance_verify_timeout_seconds: 900
```

The role requires Debian amd64 with GRUB and k3s >=1.32. It keeps GRUB_DEFAULT=0,
uses a kubelet configuration drop-in, and configures logind's inhibitor allowance.
Provisioning can restart logind and k3s to activate those settings. Installing the
kernel metapackage during bootstrap can install a kernel, but provisioning does
not immediately reboot the machine. Disabling the timer does not cancel a run
already in progress; disabling `host_maintenance_reboot` still allows package updates.

Initial bootstrap uses the existing IaC deployment path:

```sh
mise run ansible:check
mise run ansible:test
mise run ansible:plan
mise run ansible:cluster
```

The last two contact the server; only the last applies changes. Review the
Pulumi PR preview before merging its workload and monitoring changes. No local
`pulumi up` is needed. Use a maintenance window for initial provisioning because
its k3s restart is distinct from the daily kernel reboot policy.

After bootstrap, `host-provision.yaml` queues root-owned, host-local Ansible from
the merged commit on changes to Ansible or the provisioning workflow. Configure
these Forgejo repository secrets through the existing secret-management process:

- `HOST_SSH_KEY`: deployment key for `gdario@192.168.50.200` with noninteractive sudo.
- `HOST_SSH_KNOWN_HOSTS`: verified host key entry for `192.168.50.200`.

The CI connection enforces host-key verification. The initial bootstrap installs
Ansible and `/usr/local/sbin/host-provision`. The launcher waits 60 seconds before
starting provisioning, so the in-cluster CI runner can finish. Ansible then runs
independently of k3s, with the same host maintenance lock. The root-owned staging
directory is removed when provisioning exits. Collection installation needs network
access. Existing interactive controller SSH settings are not broadened by this change.

A green launcher job proves queueing, not completion. Completion is in
`journalctl -u host-provision-<commit>`. A queued application failure does not roll
back automatically. Re-run provisioning from the reviewed commit after correcting
the cause. Missing secrets fail visibly rather than silently skipping deployment.

## Monitoring and recovery

Metrics are atomically published at
`/var/lib/node_exporter/textfile_collector/host_maintenance.prom`. Pulumi mounts
that directory read-only into the existing node-exporter. Alerts cover failed,
stale, never-successful, missing, deferred, and failed-recovery states.

Set the Pulumi secret `monitoring:alertWebhookUrl` to an Alertmanager-compatible
webhook destination to receive notifications. Without it alerts are visible in
Prometheus, but notification delivery remains disabled. A plain ntfy topic URL is
not an Alertmanager-compatible webhook receiver. No destination or credentials
are invented by this change.

Monitoring runs on this host: failure to boot can only be detected by an external
availability monitor. Setting one up remains dependent on choosing an external
monitor and notification destination; this repository does not currently have one.

Read-only investigation:

```sh
systemctl list-timers host-maintenance.timer
journalctl -u host-maintenance -u host-maintenance-verify
cat /var/lib/host-maintenance/state.json
uname -r
```

After a fallback or failed recovery, correct the kernel/bootloader/workload issue
before clearing the recorded attempt. State lives in the JSON file above; retain
it with the incident evidence. Clearing it or performing recovery is an explicit
operator action, never an automatic reboot loop. Any ad-hoc infrastructure patch
or rollback requires the permission specified in AGENTS.md.

Before enabling production automatic reboots, validate on the deployed host:

- Effective kubelet shutdown configuration is 300s/30s and its logind inhibitor exists.
- A controlled kernel activation produces a new boot ID and expected kernel.
- Databases and game servers stop cleanly within their budgets and recover.
- Active backup/CI work defers maintenance, and an idle run proceeds.
- Metrics arrive in Prometheus and a test alert reaches the configured receiver.

Local tests exercise decision paths and render the units without contacting or
modifying the cluster. They do not prove bootloader or application recovery.
