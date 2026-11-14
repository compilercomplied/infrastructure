# Application access constraints

Use the [workloads](../iac/workloads/selfhosted/) for application configuration.
The exceptions below matter when provisioning accounts or diagnosing sign-in.

## Memos owner recovery

Memos retains password access for the first-run owner as a recovery path when
SSO is unavailable. Protect that account's credentials. Regular users are created
through SSO; disabling all registration would also prevent their first sign-in.
Identity uses the Authentik subject so a username change does not create a new
account. Deployment-managed settings must be changed in code because Memos treats
mounted configuration as authoritative.

## ntfy publisher credentials

Publisher tokens should be separate from the administrator account and restricted
to their topics; distributing the bootstrap administrator credential would grant
control beyond publishing. Token and ACL state must be preserved with the ntfy
auth database. The iOS wakeup relay is a delivery dependency, not the source of
notification content: clients fetch messages from the homelab.

For application-specific trust boundaries, see [Doop](doop.md), [Pulp](pulp.md),
and [Codex desktop](codex-desktop.md). [OIDC identity contracts](authentik-oidc.md)
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
