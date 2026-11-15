# Identity design constraints

The [Keycloak bootstrap](../iac/platform/core/keycloak/scripts/bootstrap.py)
breaks the dependency between a running Admin API and the provider that needs it.
Temporary administration is revoked only after permanent access is proven, so an
interrupted bootstrap does not strand the deployment. The permanent identity needs
master-realm administration to manage realms and must stay outside agent workloads.
The explicit Admin API audience is required in addition to administrator roles.

Preserve Pulumi state alongside database backups: after temporary administration
is revoked, startup bootstrap options cannot recover an existing database. Losing
both state and administrative access requires Keycloak's
[offline recovery](https://www.keycloak.org/server/bootstrap-admin-recovery)
through an automated recovery change. Administrative secret rotation must update
Keycloak and its consumer together to avoid losing the remaining access path.

## Identity ownership

[Human identity links](../iac/platform/core/keycloak/identities.ts) use immutable
Google subjects because email matching does not prove account ownership. Disabling
realm registration alone does not prevent identity-broker enrollment. Google owns
human profile updates; refresh live state before changing users because Pulumi's
`ignoreChanges` otherwise reuses potentially stale profile values. Google also
requires an exact registered callback URI; the Keycloak provider cannot configure
Google's side of federation.

[Agents use ordinary user identities](../iac/library/agent-identity.ts) so browser
sessions and personal application tokens belong to the same application account.
Separate agent credentials preserve attribution without sharing a human account or
granting infrastructure administration. Account email identifiers do not establish
mailbox ownership, so applications requiring email verification need a separate
provisioning decision.

Agent password rotation needs an explicit Keycloak reset coordinated with the pod
Secret: the provider's `initialPassword.value` applies only at user creation.
Replacing the random password alone would leave Keycloak and the pod out of sync.

## Application boundaries

Preserve application account IDs and their issuer/provider/subject bindings because
they own data, permissions, and API tokens. Historical database restores can bring
back obsolete bindings; email matching alone is insufficient to repair them.
Keycloak sign-in cannot substitute for application-specific permissions or token
provisioning. Revoking Keycloak access also cannot guarantee revocation of existing
application sessions and personal tokens, so offboarding must cover each application.

Grimmory's upstream SSRF protection blocks private OIDC hosts. Its
[scoped exception](../iac/workloads/selfhosted/grimmory/settings.ts) is needed for
the configured identity provider without relaxing metadata or import protections.
