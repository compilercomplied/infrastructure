# Application access constraints

Use the [workloads](../iac/workloads/selfhosted/) for application configuration.
The exceptions below matter when provisioning accounts or diagnosing sign-in.

## Memos owner recovery

Memos retains administrator password access as a recovery path when SSO is
unavailable. Protect that account's credentials. Regular users use SSO.
Registration is disabled: an unmapped login must fail rather than create a
duplicate account with separate notes and API tokens. New users need an explicit
provisioning step.

Memos identifies an SSO account by both provider UID and subject, not by email.
The [provider configuration](../iac/workloads/selfhosted/memos/index.ts) uses the
Keycloak provider UID and native `sub`. Keep the matching local identity records
when restoring data; changing the provider UID or subject creates a different
login binding.

Existing personal API tokens belong to the local account; changing the login
provider does not replace them with Keycloak tokens. Deployment-managed settings
must be changed in code because Memos treats mounted configuration as authoritative. See the
[account-continuity constraints](keycloak.md#account-continuity)
when changing identity bindings.

## ntfy publisher credentials

Publisher tokens should be separate from the administrator account and restricted
to their topics; distributing the bootstrap administrator credential would grant
control beyond publishing. Token and ACL state must be preserved with the ntfy
auth database. The iOS wakeup relay is a delivery dependency, not the source of
notification content: clients fetch messages from the homelab.

For application-specific trust boundaries, see [Doop](doop.md), [Pulp](pulp.md),
and [Codex desktop](codex-desktop.md). [Identity management](keycloak.md)
cover changes that must agree across the identity provider and application.

## Container startup compatibility

[Shared security defaults](../iac/library/workload-security.ts) also cover sidecars,
init containers, backups and bootstrap jobs. Capability exceptions belong beside
the workload that needs them. Users and read-only root filesystems remain explicit:
changing them centrally can break image startup or access to existing PVC data.

Keep Tandoor's upstream entrypoint: it owns database migrations, static collection
and the bundled Nginx/Gunicorn startup. Its capability exception preserves that
contract without maintaining a replacement script. Desktop and agent sandboxes
retain explicit compatibility exceptions until their nested runtimes are tested;
privileged Docker sidecars are not confined by pod-level seccomp.
