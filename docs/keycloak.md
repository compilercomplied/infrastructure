# Keycloak foundation

Keycloak runs alongside Authentik so identity migration can be tested without
changing existing login paths. The [deployment](../iac/platform/core/keycloak/index.ts)
uses the existing private-access boundary and shared PostgreSQL engine, with a
separate database and backup. Authentik remains the source of application sign-in
until each integration has an explicit account-linking and rollback strategy.

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

## Direct Google federation and staged migration

Human users are pre-linked to their existing immutable Google subjects, captured
from the current Google source links and stored in encrypted Pulumi config.
Unlinked identities are denied by a dedicated first-broker-login flow. Realm
registration being disabled would not, by itself, prevent broker enrollment.
Onboarding another person therefore requires an explicit identity mapping rather
than email matching or an invitation to whichever Google account signs in first.

Google owns human profile fields and email verification after authentication;
IaC seeds their initial values and owns the subject links and group membership.
The provider ignores subsequent profile changes rather than clearing Google's
verification flag on each deployment. No local human password is provisioned.
Group claims use the existing flat names so applications can retain their role
expressions. The identity platform's administrator credential is separate from
human users and future agent credentials.

Google federation uses a dedicated OAuth client with separate encrypted
credentials. Keeping that registration separate from Authentik isolates callback
changes and credential rotation, and preserves the old login path for rollback.
The Google-side client must accept the callback exported by the stack before a
direct login can succeed. Its testing audience must include the mapped users.
Google's [web-server OAuth documentation](https://developers.google.com/identity/protocols/oauth2/web-server#creatingcred)
requires an exact registered redirect URI. The Keycloak provider manages only
Keycloak's side of federation; it does not manage the Google-side registration.

Application clients are staged from the existing OIDC registry. Staging a client
does not move the application's configured issuer, existing accounts, or API
credentials. Migrate in this order:

1. Verify direct Google login for both known users in the Keycloak account
   console. Verify an unlinked Google identity is rejected and that human email
   verification and group claims match expectations.
2. Select one application and determine how its current account is tied to the
   old issuer and subject. Capture the old and new identity links and account ID
   before switching endpoints. A matching email alone is insufficient evidence
   that data ownership and privileges will be preserved.
3. Change that application's provider settings through code. Verify the existing
   account ID, data access, administrator/member roles, fresh login, session
   renewal, and API credentials. Retain the Authentik registration and record
   the reverse identity mapping until rollback has been tested.
4. Repeat for the remaining applications; retire Authentik only after no active
   workload depends on its issuers or federation configuration.

New agent identities should be introduced after the human-login pilot, so a new
principal and a changed identity provider are not two simultaneous causes of an
account-linking failure. Machine clients need explicit scopes and app support;
the staged browser clients deliberately do not enable client-credentials grants.
