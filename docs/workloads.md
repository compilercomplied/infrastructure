# Agentic & Sandboxed Workloads

The cluster runs an AI-agent fleet alongside the self-hosted apps. This page
covers how those workloads are structured. For the general architecture
(namespaces, security, storage) see [architecture.md](./architecture.md).

## The pieces

Agent workloads are split into four namespaces plus a shared runtime:

| Component | Namespace | Purpose |
|-----------|-----------|---------|
| Hermes Agent | `agent-sidekicks` | The assistant driving messaging, cron, and tool integration |
| MCP sidekicks | `agent-sidekicks` | Read/write tooling for Tandoor, Outline, Grafana, Kubernetes |
| Control plane | `agents-control-plane` | RBAC + service accounts for the orchestrator that coordinates worker agents |
| Workers / sandbox | `agent-sandbox` | Untrusted, agent-generated code executed in isolation |

The namespace and RBAC definitions live in `iac/modules/agents/` (namespaces,
rbac, secrets). Hermes Agent and the MCP servers are wired in
`iac/agent-sidekicks/`.

## Isolation model

Untrusted code is executed in **Kata Containers** — a real virtual machine per
pod, not a container sandbox. This is the important line: the orchestrator and
its MCP tooling run in `agent-sidekicks` under normal isolation, but anything
that *executes arbitrary agent-generated code* runs in `agent-sandbox` under the
Kata runtime class.

Kata is installed entirely through the IaC with the `kata-deploy` Helm chart,
which injects the host VM runtime and patches k3s' `containerd` to register the
RuntimeClass. That chart is a single resource in the `infrastructure` module
(`iac/infrastructure/index.ts`), which also keeps the required node label in
place across reboots. The only thing left out of IaC is the OS-level Kata
package install on the (single) node; the chart and node label are declarative.

> **Design note:** if installing Kata via a privileged DaemonSet ever fights with
> a k3s upgrade, the `infrastructure` module has the prepared fallback — move the
> binary install and `config.toml` templating to the node's Ansible setup and keep
> only the RuntimeClass in IaC.

## Hermes Agent

The self-hosted Hermes Agent runs as a `custom:selfhosted:HermesAgent` component
(`iac/components/hermes/hermes-agent.ts`) in `agent-sidekicks`. It is itself
pinned to the Kata runtime class, and talks to the LLM backend through the
LiteLLM gateway in `infrastructure` rather than holding a key per model.

Two access paths are exposed:

- **Dashboard** (`hermes.gdario.dev`) — fronted by Authentik OIDC.
- **OpenAI-compatible API** (`hermes-api.gdario.dev`) — intended for client
  apps; authenticates with its own bearer key (no SSO redirect).

Its persistent data lives on a PVC mounted at `/opt/data` (configuration,
memories, skills) and is backed up daily via the standard restic backup job
described in `architecture.md`.
