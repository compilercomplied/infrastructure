# Application constraints

Configuration lives in the [workloads](../iac/workloads/selfhosted/).

## Recovery and credentials

Memos retains administrator password access for SSO outages. Regular users need
an explicitly provisioned identity: registration is disabled to prevent duplicate
accounts with separate notes and API tokens. Preserve both the provider UID and
subject when restoring identity records; email alone does not identify the account.
Memos treats mounted configuration as authoritative, so console edits cannot
replace changes to the [deployment configuration](../iac/workloads/selfhosted/memos/index.ts).

ntfy publisher tokens should be separate from administrator credentials and
restricted to their topics. Preserve tokens and ACLs with its auth database.
The iOS wakeup relay is a delivery dependency; clients fetch notification content
from the homelab.

See [identity constraints](keycloak.md), [Doop](doop.md), [Pulp](pulp.md), and
[Codex desktop recovery](codex-desktop.md) for application-specific limitations.

## Container compatibility

Changing shared users, capabilities or filesystem permissions can break startup
and access to existing PVCs. Keep exceptions beside the affected workload.
Tandoor's upstream entrypoint owns migrations, static collection and bundled
server startup; replacing it would duplicate that lifecycle.

Desktop and agent workloads retain nested-runtime exceptions. Privileged Docker
sidecars are not confined by pod-level seccomp.
