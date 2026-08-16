# Agent Instructions

## Development loop
 - Prefer mise commands. Manage the lifecycle of the project through mise when
	 possible.
 - Never `pulumi up`. Only preview. PR CI acts as a source of truth (unless
	 pairing with a human).

## Architectural Guardrails
* **Priority 1: Zero ClickOps**: Maintain the infrastructure completely automated. Never perform manual steps or "ClickOps". While temporary hacks to restart or patch components for the sake of rollbacks are acceptable, you must **always ask for explicit permission**.
* **Zero-Trust Default-Deny Model**: Enforce a zero-trust default-deny model for incoming traffic (`default-deny-ingress`) across namespaces. Incoming traffic must be blocked by default, and workloads must explicitly define NetworkPolicies to permit required ingress connections.

## Core Tenets for Code Comments
* **Never state WHAT the code is doing**: The code itself should be readable enough to explain what it does (e.g. creating a deployment, declaring a variable). Avoid redundant comments like `// Create Secret for Django security`.
* **Always explain WHY**: Comments should provide additional context, explain why a particular decision was made, and outline the constraints that were faced.
* **Add Context**: For example, instead of writing `// Redis Deployment`, explain *why* Redis is needed: `// Redis is a hard dependency for authentik. It is used as an internal task queue.`
