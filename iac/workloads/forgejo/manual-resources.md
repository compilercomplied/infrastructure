# Forgejo organization review webhook

The review hook is declaratively owned by [review-webhook.ts](./review-webhook.ts),
not a manual exception. Teams, branch policies and the private-destination allowlist
remain under their existing IaC owners.

## Provider boundary

The generated `@pulumi/forgejo` SDK and the upstream
[svalabs/forgejo v1.7.0 resource registry](https://github.com/svalabs/terraform-provider-forgejo/blob/v1.7.0/internal/provider/provider.go)
expose `RepositoryWebhook` only. Its `repositoryId` is required; it cannot adopt
an organization hook. A Pulumi dynamic provider therefore uses Forgejo's supported
organization-hook API at deployment time. The privileged credential is the existing
secret `forgejo:apiToken`, never a runtime controller credential.

## Desired state and adoption

One active `forgejo` JSON POST hook covers existing and future `home` repositories.
The destination is exactly
`http://orchestrator-api.agent-dev-environment.svc.cluster.local/webhooks/forgejo`.
PR/comment/review/sync, push and Actions success/failure/recovery events wake the
controller. Event groups are normalized to Forgejo's expanded readback form.

The dynamic resource `forgejo-home-review-webhook` lists hooks with bounded
pagination and requires exactly one matching destination with the existing ID
`home/1`. Initial adoption only reads the hook and fails if its observable
configuration differs. It never POSTs, deletes or substitutes another hook ID.
Missing hooks, duplicate destinations and incompatible identities fail closed on
adoption, refresh and update. Readback verifies active/type/content/event state;
refresh exposes observable configuration drift to Pulumi.

Updates skip PATCH entirely when observable configuration already matches,
including an API credential change. Supported configuration drift is reconciled on
the same hook, preserving its live branch filter and omitting the write-only
secret. Forgejo 16.0.5's PATCH also leaves Actions flags untouched and overwrites
the authorization header; incompatible Actions coverage or a nonempty header
therefore fails before mutation rather than partially reconciling the hook.

The secret comes from the encrypted `reviewWebhookSecret` output of
`gdariodev/agent-dev-environment/prod`, including the review service's canonical
explicit-secret-or-HMAC fallback. No new stack secret is required. Forgejo does not
return this write-only value; initial adoption preserves the existing matching
secret, and signed event delivery is the end-to-end proof of agreement.

Forgejo 16.0.5's API [editHook](https://codeberg.org/forgejo/forgejo/src/tag/v16.0.5/routers/api/v1/utils/hook.go)
does not assign the HMAC Secret on PATCH. Consequently
the resource explicitly rejects a changed secret rather than falsely reporting a
successful rotation or replacing the live hook. Coordinate any future rotation
through a supported owner-side mechanism and reconcile the input only after
verifying signed delivery. Out-of-band secret drift is not detectable by GET.

The resource is protected and retained on deletion. Removing an IaC declaration
does not disable or delete the live hook; retirement must be an explicit reviewed
owner action. This prevents infrastructure refactors from silently stopping reviews.

## Operational verification

Read `GET /api/v1/orgs/home/hooks/1` using an owner-side credential and verify its
ID, destination, active flag, content type and event coverage. Confirm the same
`home/1` ID and its protection/retention flags in Pulumi state. After deployment,
use a harmless event on an authorized PR and verify signed `webhook_persisted`
delivery in the controller logs. This proves webhook ownership and delivery, not
the broader review controller's enrollment, model execution or recovery behavior.
