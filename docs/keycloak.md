# Keycloak foundation

Keycloak runs alongside Authentik so identity migration can be tested without
changing existing login paths. The [deployment](../iac/platform/core/keycloak/index.ts)
uses the existing private-access boundary and shared PostgreSQL engine, with a
separate database and backup. Authentik remains the source of application sign-in
until each integration has an explicit account-linking and rollback strategy.

## Administrative bootstrap

The Keycloak provider needs a running Admin API and credentials before it can
manage identities. This first stage establishes that prerequisite; realm, Google
federation, application clients, and agent identities belong to the subsequent
provider-managed configuration stage. The existing Google OAuth registration
will also need the new broker callback before Google login can be tested.

An initial temporary service administrator creates a permanent `pulumi` client.
The [bootstrap Job](../iac/platform/core/keycloak/scripts/bootstrap.py) verifies
that the permanent client can administer Keycloak before deleting the temporary
client. Reruns authenticate with the permanent client, falling back to the
temporary client if an interrupted attempt has not finished granting access.
The client explicitly receives the built-in Admin API scope because recent
Keycloak versions require the intended audience in addition to administrator
roles. Generated credentials are
retained in encrypted Pulumi state and delivered as Kubernetes Secrets; no
credential entry or console setup is required.

The permanent client has the master realm's administrator role so a later
provider stage can create and manage realms. It is infrastructure control-plane
access: never deliver it to Codex, Hermes, or ordinary applications. The running
server receives database and temporary-bootstrap credentials, not the permanent
administration secret. Stack outputs expose the provider URL, client ID, and
secret-marked client secret. Consume the secret through Pulumi rather than
printing it into logs.

Do not independently replace the automation password resource or rotate the
client secret through the console. Once the temporary administrator is removed,
the startup bootstrap options cannot recover access to an existing database.
Rotation requires authenticating with the current credential, updating both
Keycloak and its secret consumer, and verifying the replacement. Loss of both
state and administrator access requires the upstream
[offline recovery procedure](https://www.keycloak.org/server/bootstrap-admin-recovery),
performed through a separately reviewed automated recovery change. Preserve the
Pulumi state as well as database backups.

The server uses production mode with TLS terminated by the private ingress.
Its writable image filesystem permits the upstream startup build; identity state
lives in PostgreSQL. Local cache and a single replica match the homelab's accepted
maintenance downtime. Management health endpoints are used by kubelet probes and
are excluded from the application Service and ingress.

Run `mise run keycloak:check` to exercise fresh and repeated database provisioning,
interrupted bootstrap recovery, revocation, restart persistence, and administrative API
access in disposable local containers. This does not contact the cluster. PR CI
remains the deployment-preview source of truth.
