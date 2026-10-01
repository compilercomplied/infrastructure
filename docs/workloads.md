# Agent Workloads

The cluster runs agent workloads alongside the self-hosted apps. This page
covers how those workloads are structured. For the general architecture
(namespaces, security, storage) see [architecture.md](./architecture.md).

## The pieces

Agent resources are organized across these namespaces:

| Component | Namespace | Purpose |
|-----------|-----------|---------|
| Hermes Agent | `agent-sidekicks` | The assistant driving messaging, cron, and tool integration |
| MCP sidekicks | `agent-sidekicks` | Read/write tooling for Tandoor, Outline, Grafana, Kubernetes |
| Control plane | `agents-control-plane` | RBAC + service accounts for the orchestrator that coordinates worker agents |
| Sandbox namespace | `agent-sandbox` | Namespace and network-policy baseline for experiments |

The namespace and RBAC definitions live in `iac/workloads/agents/control-plane/` (namespaces,
rbac, secrets). Hermes Agent and the MCP servers are wired in
`iac/workloads/agents/`.

## Experimental Kata runtime

Kata is included in the cluster solely for virtualization experiments. The
`agent-sandbox` namespace has a default-deny ingress policy and provides a
place for experiments; it does not currently define an execution workload.

Kata is installed entirely through the IaC with the `kata-deploy` Helm chart,
which injects the host VM runtime and patches k3s' `containerd` to register the
RuntimeClass. That chart is a single resource in the `infrastructure` module
(`iac/platform/core/index.ts`), which also manages the node label. The chart's
privileged installer handles the host runtime setup.

## Hermes Agent

The self-hosted Hermes Agent runs as a `custom:selfhosted:HermesAgent` component
declared in `iac/library/hermes-agent.ts`, with its deployment in
`iac/workloads/agents/hermes-agent/index.ts`. It talks to the LLM backend through the
LiteLLM gateway in `infrastructure`.

Two access paths are exposed:

- **Dashboard** (`hermes.gdario.dev`) — fronted by Authentik OIDC.
- **OpenAI-compatible API** (`hermes-api.gdario.dev`) — intended for client
  apps; authenticates with its own bearer key (no SSO redirect).

Its persistent data lives on a PVC mounted at `/opt/data` (configuration,
memories, skills) and is backed up daily via the standard restic backup job
described in `architecture.md`.

Hermes provides a shell with the Docker CLI, Android SDK, and emulator tools.
Its main container receives a KVM device allocation and a persistent AVD volume.
A dedicated DinD sidecar supplies the Docker daemon through `DOCKER_HOST`;
Docker images and containers use ephemeral storage. The main container has the
device and tools needed for an accelerated emulator. KVM access inside containers
started by DinD has not been validated. The device path, CI-runner design, and operational
checks are documented in [android-emulation.md](./android-emulation.md).
