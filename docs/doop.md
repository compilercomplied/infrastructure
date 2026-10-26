# Doop

Doop replaces Penpot at `https://design.gdario.dev`. Its MCP endpoint is
`https://design.gdario.dev/mcp`. The browser UI, MCP server and screenshot
renderer run together; a browser tab does not need to remain open for MCP.

## Authentication

Authentik is configured through the shared OIDC registry, with callback
`/api/auth/oauth2/callback/oidc` and the local verified-email mapping.
New Authentik users are provisioned on their first successful login.
`ADMIN_EMAILS` comes from the encrypted `selfhosted:user-gdario-email` value:
Doop promotes this account on creation when Authentik asserts its email is
verified. The first person to sign in does not receive admin automatically.

The pinned upstream version bypasses password email verification when SMTP is
unset, even if `REQUIRE_EMAIL_VERIFICATION` is true. The Nginx sidecar therefore
rejects password signup, login, recovery and password-setting endpoints. Its
configuration is in `iac/workloads/selfhosted/doop/nginx.conf`; only port 8080
is exposed by the Service and Traefik policy. Doop's port 4400 has no Service.
The upstream UI may still show its password/signup controls; those requests
return 403 with instructions to use Authentik. No upstream source is patched.

In Settings → Agent keys, mint separate keys for each agent. Connect each
client to `/mcp` with `Authorization: Bearer dpk_…`. These keys carry the
account's canvas access, not per-key read-only permissions. Uploaded assets
and frame images remain accessible to anyone who knows their URLs, per
upstream's security policy.

## Build and deploy

The image is built and published by [dario/doop](https://git.gdario.dev/dario/doop).
Every push or merge to its master branch runs its Forgejo Actions workflow,
tests production OIDC administrator bootstrap, and publishes to dario's user
packages as both a full commit SHA tag and latest. The homelab pins a commit
SHA in `iac/workloads/selfhosted/doop/image.txt`; it does not build or publish
application images. The application uses unmodified upstream source.

Run `mise run doop:check` to smoke-test the published image with the same proxy
configuration used in the cluster, including blocked password signup, preserved
OIDC/MCP endpoints and a headless Chromium screenshot.

The existing encrypted Penpot database, API and OIDC secrets are renamed to
Doop configuration keys; no plaintext secrets are added. Penpot's database is
not dropped by this change. Its managed workloads, asset PVC, backup schedules
and Authentik application/provider are removed. Explicit absent-state blueprint
entries remove the old identity rather than leaving a stale launcher behind.

## Storage and operations

Doop has a dedicated `doop` database/user in shared PostgreSQL, bootstrapped by
a Job before app startup. `/app/data` is a 20 GiB local-path PVC for uploaded
assets. Both have the normal restic backups. One replica with Recreate updates
avoids concurrent in-memory canvas stores and competing local-path writers.
The health endpoint is `/healthz`, checked by pod probes and a monitoring Probe.
The namespace keeps default-deny ingress; the app explicitly allows Traefik,
and its labels permit access to shared PostgreSQL and Authentik.
