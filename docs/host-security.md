# Host SSH protection

Ansible's `host_security` role enables public-key SSH and disables password and
keyboard-interactive authentication. It authorizes the MacBook Air public key
from `ansible/roles/host_security/files/gdario-macbookair.pub` without removing
other authorized keys. The private key stays on the Mac.

Host provisioning uses a separate CI key so revoking or rotating deployment access
does not affect personal access. Ansible authorizes it with SSH's `restrict`
option, disabling forwarding and PTYs while allowing the noninteractive commands
needed by provisioning. The workflow verifies that its private key matches the
declared public key and checks the server against an authenticated host-key pin.

The [Pulumi resources](../iac/workloads/forgejo/host-provision.ts) manage both
repository secrets; the private key comes from encrypted stack configuration.
CI connects as the host administrator because Ansible manages root-owned files
and services. Repository workflow changes therefore remain privileged changes.
Initial authorization uses the existing administrator connection and the same
Ansible role. For rotation, authorize the replacement public key before publishing
the replacement private key, then verify the provisioning workflow succeeds.

Fail2ban watches the host SSH journal. Five logged failures within ten minutes trigger
a one-hour ban using nftables on the SSH port. Only loopback is exempt; LAN and
Tailscale addresses can be banned too. This protects host SSH, not application
authentication or Kubernetes ingress. It does not make SSH publicly reachable.
Rejected public keys count too. Clients offering several obsolete keys can
trigger a ban; use `IdentitiesOnly yes` with the intended identity in SSH client
configuration when an agent holds multiple keys.

## Apply and verify

From the repository root, with deployment approval:

```sh
ANSIBLE_CONFIG="$PWD/ansible/ansible.cfg" ansible-playbook \
  ansible/playbooks/provision_cluster.yml --tags host-security
```

Keep a working administrator session while changing SSH authentication. Verify a
fresh connection with the declared private key before closing it. An Ansible
check run on a host without Fail2ban cannot exercise its service handlers until
the package has been installed.

Read-only checks on the host:

```sh
sudo sshd -T
sudo fail2ban-client status sshd
sudo nft list ruleset
systemctl status fail2ban fail2ban-metrics.timer
cat /var/lib/node_exporter/textfile_collector/fail2ban.prom
sudo tail /var/log/fail2ban/fail2ban.log
```

To recover a mistakenly banned client through another administrator connection
or the host console, run `sudo fail2ban-client set sshd unbanip <client-ip>`.

## Grafana data

Pulumi provisions the **Host SSH and Fail2ban** dashboard, UID `host-fail2ban`.
The existing node exporter reads an atomic textfile written every minute by
`fail2ban-metrics.timer`. The dashboard shows active bans, cumulative failures
and bans, rates, collector health and data age. Total counters reset when the
jail restarts. Check both health and age: an old success value does not prove
the collector is still running.

Alloy mounts only `/var/log/fail2ban` read-only and sends its events to Loki
under `job="fail2ban"`. IP addresses appear in event logs, not metric labels.
Logs follow Loki's existing retention policy; the host rotates its local log
weekly and retains four rotations. Alerts and external monitoring are separate
from this dashboard.
