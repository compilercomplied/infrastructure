# Doop access constraints

Use Authentik for sign-in. The deployed upstream version bypasses password email
verification when SMTP is unset, even with verification required. The
[proxy](../iac/workloads/selfhosted/doop/nginx.conf) closes those password routes
because an environment setting alone cannot enforce the intended account policy.
The UI may still display password controls; their rejection is intentional.
Administrator bootstrap requires the declared account's verified email rather
than granting control to whoever signs in first.

Agent keys inherit the account's canvas access; separate keys do not create
read-only roles. Uploaded asset and frame URLs are accessible to anyone who knows
them, so keep sensitive material out of shareable URLs.

The [image publisher](https://git.gdario.dev/dario/doop) owns application builds;
this repository selects the published artifact. Keep the
[image reference](../iac/workloads/selfhosted/doop/image.txt) tied to that source
when upgrading. `mise run doop:check` checks the authentication boundary as well
as rendering, because a healthy UI would not reveal a reopened signup route.

Doop keeps canvas state in memory as well as storage. Concurrent replicas or
overlapping updates can create competing writers; preserve that constraint when
changing its rollout strategy.
