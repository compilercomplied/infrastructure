# Forgejo

Only Owners push directly to protected branches. Owners and Contributors can
merge PRs after CI passes and an Owner or Reviewer approves. The `reviewing-bot` account joins
Reviewers across all organization repositories. CI, stale-approval dismissal,
requested-review blocking, and squash merging remain required.

Add repos in [repositories.ts](./repositories.ts) with `createRepo({ name })`.
The organization defaults to `home` and repos are public unless `isPublic: false`.
Organizations must already exist. Personal repos stay under their owners' control.

Repositories use `master` as their default and only managed protected branch.
Existing repositories and teams are already adopted into Pulumi state; normal
configuration does not carry import IDs.

The organization review webhook is adopted and reconciled by
[review-webhook.ts](./review-webhook.ts). Its lifecycle and secret source are
documented in [manual-resources.md](./manual-resources.md).

## Storage retention

[Forgejo settings](./app/settings.ts) give new Actions artifacts a 14-day default.
Workflows can set an explicit lifetime. Forgejo stores the expiry on upload and
its built-in cleanup removes expired files. Existing artifacts follow their
recorded expiry dates. Workflow run records are retained independently.
[Forgejo Actions storage](https://forgejo.org/docs/v16.0/admin/actions/#storage)

The Android image publisher stores the image in the registry by commit tag.
Its workflow keeps only the digest, manifest, and checksums as CI artifacts.
Consumers pull by digest. The publisher README documents how to export an
offline copy when needed. The November 8, 2026 audit measured 3.4–4.2 GiB
per archive, making this workflow the main source of artifact storage.
[Android image publisher](https://git.gdario.dev/hermes/android-ci-image)

Forgejo owner-level rules control package version retention. Its built-in
package cleanup reclaims blobs once all references are gone. Keep every tag
or digest referenced by deployments, CI, or rollback instructions when
reviewing a rule. The old cluster-wide prune job had no check for those
references, and its Actions pass used field names absent from Forgejo's run
API. The retention rollout retires that job.
[Forgejo package cleanup](https://forgejo.org/docs/v16.0/user/packages/#cleanup-rules)

### Rollout verification

1. Check that the Pulumi preview updates `forgejo-config` and the Forgejo
   Deployment in place. `SelfhostedApp` enables in-place updates for settings
   ConfigMaps with a Pod template checksum, which rolls out the new environment.
   The Deployment uses `Recreate`, so the rollout briefly interrupts service.
   The preview should also remove the `forgejo-prune` CronJob and script
   ConfigMap and update the ingress policy to remove the prune exception.
2. After CI deploys the change, verify that the Forgejo Deployment is ready,
   the retention setting is present, and the old CronJob is absent.
3. After the next Android image publish, verify that the registry digest can
   be pulled and that the Actions artifact contains only metadata. Track
   Forgejo PVC usage as the previous archives reach their stored expiry dates.
