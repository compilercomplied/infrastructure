# Pulp trust and retention constraints

Browser SSO and package-client authentication serve different callers. Browsers
can follow Authentik redirects; build tools need a machine credential and a real
authentication failure. Keep the trusted identity header behind the proxy so a
client cannot assert another user's email. The declared operator account gets
administrator privileges; other authenticated users still need explicit RBAC.

SSO does not make distribution content private. A distribution without a content
guard can publish anonymous content. The CI Maven listener is deliberately
separate from the public listener so its distributions can be reachable by the
runner without making the same paths public. Preserve that boundary when editing
[the proxy](../iac/workloads/selfhosted/pulp/nginx.conf).

## Why CI uses a cache

The runner's shared egress received HTTP 429 for required Maven Central
artifacts. The cache reduces repeated upstream requests; the Google Cloud
Central mirror avoids the affected upstream path. Keep the upstream repositories
separate so identical relative paths do not mix unrelated artifact sources.
An empty cache still depends on upstream availability.

Before orphan cleanup, verify that cached content belongs to a retained
repository. Maven plugin releases changed automatic association and removed the
old `add_cached_content` action; use the installed plugin's behavior rather than
a generic cleanup recipe. See the [Maven plugin changelog](https://pulpproject.org/pulp_maven/changes/).
The bundled UI does not provide the deployed Maven, Python, or npm management
screens; use the API or CLI for those formats.

## Recovery dependencies

The private `https://pulp.gdario.dev/pulp/content/ci-tools/` distribution stores
the pinned Pulumi CLI, Forgejo Terraform provider, and monitoring Helm charts.
Pulp's initialization mirrors the declared versions, verifies archive checksums,
and publishes the repository after every required file is available. Old versions
remain available for rollbacks. A warm initialization reuses stored files.

CI downloads these archives and their checksum metadata from Pulp. A version
missing from the mirror falls back to its official release source so version
update PRs can run before deployment populates the mirror. Network failures and
server errors fail the build. The explicit `PULP_BOOTSTRAP=1` environment setting
bypasses Pulp for initial provisioning or recovery. For example, run
`PULP_BOOTSTRAP=1 mise run preview-deployment` when Pulp is unavailable. The CLI
installer is `node iac/scripts/install-pulumi.cjs` and uses the same setting.

Restore `pulpDbEncryptionKey` with the database: database contents alone cannot
recover encrypted remote credentials. Package files must also agree with the
restored database. Redis sessions are disposable; their loss can require another
browser sign-in but should not be mistaken for lost package content. Server-side
sessions avoid oversized cookies during OIDC token refresh.
