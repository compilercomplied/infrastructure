# Host provisioning boundaries

The installer controller and the cluster node are different machines. Controller
support for macOS does not imply that the cluster playbook supports macOS.
[The inventory](hosts.ini) and [playbooks](playbooks/) define supported targets;
[mise](../mise.toml) exposes validation, preview, and apply tasks.

PXE startup is separate from ordinary provisioning because it enables an
unattended OS installer on the LAN. **The preseed erases the first disk.** Review
its [disk, bootstrap credentials, and SSH-key inputs](roles/bare_metal/templates/preseed.cfg.j2)
before an authorized reinstall. The controller needs Docker and dnsmasq, and its
HTTP address must be reachable from the node. Router DHCP still owns the node's
address reservation; proxy DHCP does not replace it.

Initial cluster provisioning can restart k3s and logind. Use a maintenance window:
the CI runner and applications share this node. After bootstrap, host-local
provisioning can outlive the runner that queues it. See
[maintenance and recovery](../docs/host-maintenance.md) for how to distinguish
queueing from completion.

Syntax checks and local maintenance tests do not contact the node. Ansible check
mode does contact it and can require sudo; it does not prove that a real
installation or reboot will recover. Keep hardware-specific fan configuration
with the [cluster role](roles/cluster/) rather than copying its values here.
