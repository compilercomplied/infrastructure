# Pulp constraints

Keep trusted identity headers behind the [proxy](../iac/workloads/selfhosted/pulp/nginx.conf):
callers must not be able to assert another user's email. Package clients need
machine authentication and authentication failures rather than browser redirects.
SSO does not grant application permissions or make distribution content private.
Distributions need a content guard when their content must not be anonymous.

The CI Maven listener isolates runner-only mirrors from public distribution paths.
Shared runner egress encountered Maven Central rate limits; caching and the Google
Cloud mirror avoid repeated requests through that path. Keep upstream repositories
separate to prevent identical relative paths from mixing artifact sources.
An empty cache still depends on upstream availability.

Before orphan cleanup, verify that cached content belongs to a retained repository.
Maven plugin versions differ in automatic content association; check the
[plugin changelog](https://pulpproject.org/pulp_maven/changes/) before choosing a
cleanup procedure. The bundled UI lacks Maven, Python and npm management screens,
so those formats require the API or CLI.

CI depends on Pulp for pinned tooling and Helm archives. Missing versions fall
back to official releases so update PRs can run before the mirror is populated;
network and server errors fail the build. `PULP_BOOTSTRAP=1` bypasses the mirror
for initial provisioning or recovery. Retain old versions for rollbacks.

Restore `pulpDbEncryptionKey` with the database; without it, encrypted remote
credentials are unrecoverable. Package files must match the restored database.
Server-side sessions avoid oversized cookies during OIDC refresh. Losing Redis
sessions can require another sign-in without losing package content.
