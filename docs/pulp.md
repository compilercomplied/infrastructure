# Pulp

Pulp is declared at `https://pulp.gdario.dev`. The pinned `pulp/pulp:3.90`
image includes Maven, Python and npm plugins. Its bundled UI does **not** provide
Maven, Python or npm repository-management screens; use Pulp's REST API or CLI
for those formats.

## Authentication

Browser access uses the Authentik `pulp` OIDC application through oauth2-proxy.
Nginx replaces the trusted identity header with the verified OIDC email. API,
content and identity listeners bind only to loopback inside the Pod; only Nginx
is exposed by the Service. The declared `user-gdario-email` account is reconciled
as the operator administrator, with an unusable password on first creation.
Other OIDC users receive no administrative privileges automatically.

Automation uses Pulp users with passwords and explicit RBAC assignments, created
through Pulp's authenticated API. Send HTTP Basic authentication to machine
endpoints; they return authentication failures rather than redirecting clients
to Authentik:

- `/pulp/api/v3/`: repository, remote, distribution and user management.
- `/pypi/<distribution>/`: Python simple index and legacy upload API.
- `/pulp/maven/<distribution>/`: Maven deployment API.
- `/pulp/content/`: published package content, including plugin-specific routes.

Distribution content guards control access to published content. A distribution
without a content guard can be public; browser SSO does not make it private.

## Android CI Maven mirrors

The Android runner uses the read-only endpoint at
`https://pulp-ci.gdario.dev:8081/pulp/content/android-ci/`. Cluster DNS maps
the name to Pulp's Service, and cert-manager issues its certificate using
DNS-01. The Android runner pod and its job containers can reach this port
through the existing network policies. The public HTTPS listener blocks
the three CI distributions.

Pulp fetches and stores requested files on demand. The distributions
`google-maven`, `maven-central`, and `gradle-plugins` keep the upstreams
separate. The Central remote uses the Google Cloud mirror because the runner's
egress hit HTTP 429 at Maven Central for a required Robolectric JAR. Mood
Tracker's first run with empty dependency caches warms the files it requests.

With the pinned Maven plugin, cached files are served from Pulp storage on
subsequent requests. To retain them across a Pulp orphan cleanup, promote the
cached content into each distribution's repository with the
`add_cached_content` API before running the cleanup.

## State and recovery

The shared PostgreSQL database and the 30 GiB `/var/lib/pulp` volume have the
standard database and PVC backups. The init container migrates the database
before API, content and worker processes start. The single-replica Deployment
uses `Recreate` to avoid overlapping writers.

Keep `pulpDbEncryptionKey` when restoring the database: it encrypts stored remote
credentials. `pulpDbPassword`, `pulpSecretKey`, `pulpOidcClientSecret` and that
key remain encrypted in the Pulumi stack configuration. The OIDC client secret
is shared with Authentik through the central OIDC registry.

Redis stores only disposable oauth2-proxy sessions, on loopback with a 64 MiB
memory cap and no persistence. A Redis restart or eviction can require another
browser sign-in; it does not lose packages or Pulp tasks. Server-side sessions
avoid oversized split cookies during token refresh.

`/healthz` checks the Pulp API status through the public listener. Container
readiness also checks API, content, worker process and session-store availability;
`/nginx-healthz` is the frontend liveness endpoint.
