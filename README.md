# Infrastructure

This project contains the infrastructure-as-code (IaC) for a k3s cluster containing different workflows.


Check [workloads.md](./docs/workloads.md) to see the currently configured
workloads covering different features and services.

All infrastructure code written in pulumi is using pulumi servers for the state.

# Deployment view

This is deployed locally through the local pulumi stack. Related tasks are in
`mise.toml`.

# Local development

Mise is a pre-requisite. The task `mise run project-setup` configures the
project.

## Grafana Access

You can use the scripts in the `scripts/` directory to easily access Grafana locally via port-forwarding.

### 1. Get Admin Password
Run this script to retrieve and decode the admin user's password.

```bash
./scripts/get-grafana-password.sh
```

### 2. Port Forward
Run this script in a separate terminal to access Grafana at [http://localhost:3000](http://localhost:3000).

```bash
./scripts/port-forward-grafana.sh
```
