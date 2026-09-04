# Infrastructure

This project contains the infrastructure-as-code (IaC) for a k3s cluster
containing different workflows. All infrastructure code is written in Pulumi;
state is hosted on Pulumi.

- **[architecture.md](./docs/architecture.md)** — the high-level map: cluster
  topology, namespaces, security & storage patterns, and the shared-database
  model.
- **[workloads.md](./docs/workloads.md)** — the agentic and sandboxed workflows
  (Hermes Agent, MCP sidekicks, Kata-isolated sandbox).
- **[selfhosted.md](./docs/selfhosted.md)** — how self-hosted services are
  declared and exposed.

# Deployment view

This is deployed through the local Pulumi stack, and its CI preview runs on
every pull request. Related tasks live in `mise.toml`. **Never run `pulumi up`
by hand** — changes land via a merged PR.

# Local development

Mise is a prerequisite. The task `mise run project-setup` prepares the project
(toolchain + deps); `mise run preview-deployment` runs the validation dry-run.
