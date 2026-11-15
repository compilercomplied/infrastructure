# Keycloak identity management

Keycloak provides application sign-in through the private-access boundary. Its
[deployment](../iac/platform/core/keycloak/index.ts) uses shared PostgreSQL with
a separate database and backup. The [client registry](../iac/platform/core/oidc-apps.ts)
and application adapters define matching callbacks, scopes and encrypted credentials.

## Administrative bootstrap

The Keycloak provider needs a running Admin API and credentials before it can
manage identities. The hosting bootstrap establishes that prerequisite; the
[identity configuration](../iac/platform/core/keycloak/identities.ts) then manages
the application realm through native provider resources.

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

## Human access and Google federation

Human users are pre-linked to their existing immutable Google subjects, stored in encrypted Pulumi config.
Unlinked identities are denied by a dedicated first-broker-login flow. Realm
registration being disabled would not, by itself, prevent broker enrollment.
Onboarding another person therefore requires an explicit identity mapping rather
than email matching or an invitation to whichever Google account signs in first.

Google refreshes human profile fields and email verification on authentication;
IaC owns the subject links and group membership. Refresh live user state before
updates to existing users: Pulumi's `ignoreChanges` reuses recorded state, which
may predate Google's latest profile update. Human users have no local passwords.
Flat group claims preserve the applications' existing role expressions.

Google federation uses a dedicated OAuth client with encrypted credentials. The
Google-side client must accept the callback exported by the stack; Keycloak's
subject links control enrollment. Google's
[web-server OAuth documentation](https://developers.google.com/identity/protocols/oauth2/web-server#creatingcred)
requires an exact registered redirect URI. The Keycloak provider manages only
Keycloak's side of federation.

## Account continuity and machine access

Applications bind their original local accounts to native Keycloak subjects. Some
include the issuer or local provider name in that key. Preserve local account IDs:
they own data, permissions and API credentials. Future identity-provider changes
need conflict-checked mappings verified against immutable upstream identities;
email matching alone does not establish continuity. There are no legacy subject
claims, runtime migration adapters or Authentik login paths.

An OIDC client registration does not provision an application account, grant app
permissions or create an API token. Browser clients deliberately exclude
client-credentials grants. Agents still need the application's supported machine
authentication and explicitly granted permissions; moving browser sign-in does
not convert existing application tokens into Keycloak tokens.

## Recovery after retirement

The retired Authentik database and its media/template volumes were retained as
offline recovery data, with the database role disabled for login. Final snapshots are in the encrypted Restic repository;
the two retained PVCs are outside active Pulumi ownership. They are not a live
login dependency. Restore historical data in isolation: restoring an old app
database can also restore obsolete identity bindings, so verify its native
Keycloak links before reopening access. Never reassign another person's subject.

The retired Google OAuth client may still exist in its original, inaccessible
Google Cloud project. Removing that registration is separate from homelab
retirement; no running workload consumes its credentials.

Grimmory's upstream HTTP client blocks private OIDC hosts by default. Its
[OIDC-only exception](../iac/workloads/selfhosted/grimmory/settings.ts) permits
the administrator-configured private Keycloak endpoints; metadata and import
requests retain their separate SSRF filtering.
