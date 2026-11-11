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
