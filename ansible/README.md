# Cluster host provisioning

Ansible manages the Debian cluster at `192.168.50.200`, connecting as `gdario`
with sudo. The playbook checks the target address and Debian distribution before
running any roles.

Run from the repository root with Ansible installed:

```sh
mise run project-setup
mise run ansible:check
mise run ansible:cluster
```

The single playbook manages the administrator account, Debian package sources
and host utilities, inotify limits, dual-stack k3s, open-iscsi for Longhorn,
sensor modules, and fancontrol. Debian settings are in
`playbooks/group_vars/cluster.yml`; fan settings are in
`roles/cluster/defaults/main.yml`.

Fan control discovers coretemp and nct6776 hwmon devices at runtime.
`pwm1` is the chassis fan (full speed at normal temperatures); `pwm2` is the CPU
cooler (35–60°C curve, minimum PWM 90, three-second polling).

`ansible:check` validates syntax without contacting the host. `ansible:cluster`
applies configuration. The PXE playbook runs on the controller to install the cluster OS:

```sh
mise run ansible:pxe-start
mise run ansible:pxe-stop
```

It serves Debian netboot files through dnsmasq (proxy DHCP and TFTP) and
`preseed.cfg` through a Docker nginx HTTP server on port 8080. BIOS and UEFI
boot templates are included. Docker and dnsmasq must be installed on the
controller; macOS and Debian service handling is retained because the
controller is separate from the Debian cluster.

PXE defaults live in `roles/bare_metal/defaults/main.yml`. The controller address
`pxe_server_ip` must be reachable from the cluster. The router still assigns
the node address through DHCP; retain its reservation for `192.168.50.200`.
After OS installation, run `mise run ansible:cluster`.

The unattended preseed erases the first disk and retains the original bootstrap
password and SSH-key injection, including the local secrets-key lookup. Review
`roles/bare_metal/templates/preseed.cfg.j2` before starting installation.
Starting PXE changes controller services; it is a separate explicit task so
ordinary cluster provisioning does not start an installer on the LAN.

## Automatic host maintenance

Provisioning also installs the daily update timer and graceful shutdown settings.
See [host maintenance](../docs/host-maintenance.md) for the schedule, safeguards,
CI bootstrap requirements, monitoring, and recovery. `mise run ansible:test` runs
maintenance safety tests without contacting the server; `mise run ansible:plan`
previews provisioning with Ansible check/diff mode.
