# Homelab infrastructure

Changes go through PR review and CI deployment so the repository remains the
source of truth. Run setup and preview through [mise](mise.toml); never apply
Pulumi changes locally. See [agent instructions](AGENTS.md) before contributing.

The code owns resource inventories, hostnames, settings, and deployment mechanics.
Start at [the Pulumi entry point](iac/index.ts) or [the Ansible playbook](ansible/playbooks/provision_cluster.yml).
Documentation preserves the reasoning and operational constraints:

- [Architecture decisions](docs/architecture.md)
- [Host provisioning boundaries](ansible/README.md) and [maintenance recovery](docs/host-maintenance.md)
- [Application access constraints](docs/selfhosted.md) and [OIDC identity contracts](docs/authentik-oidc.md)
- [Recovery limitations](docs/recovery.md)
- [Codex desktop](docs/codex-desktop.md), [Doop](docs/doop.md), and [Pulp](docs/pulp.md)
- [Forgejo lifecycle constraints](iac/workloads/forgejo/README.md)
