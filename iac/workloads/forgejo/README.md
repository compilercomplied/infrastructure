# Forgejo lifecycle constraints

Organization repositories are managed centrally so new projects inherit review
and branch policy. Personal repositories remain under their owners' control.
Use [the repository declarations](repositories.ts) and [policy](policy/) for
current permissions rather than maintaining a second matrix here.

The runner can deploy changes to itself. Replacing it during a Pulumi update can
terminate the job before the update completes; a merged commit is not evidence
that the deployment settled. Check the completed deployment before retrying or
assuming a failed run rolled back.

## Retention is not reference-aware garbage collection

Large Android image archives were consuming Actions storage despite already
being published to the registry. The [image publisher](https://git.gdario.dev/hermes/android-ci-image)
keeps CI artifacts as metadata; use its export procedure when an offline image
is actually needed.

Changing the Actions retention default does not rewrite expiry dates on existing
artifacts. Package cleanup is separate and can remove an image still referenced
by a deployment or rollback procedure: protect those versions when changing
owner-level rules. The retired cluster-wide prune job did not check references.
See [Actions storage](https://forgejo.org/docs/v16.0/admin/actions/#storage) and
[package cleanup](https://forgejo.org/docs/v16.0/user/packages/#cleanup-rules).

[Organization review webhook constraints](review-webhook.md) explain why hook
adoption, rotation, and retirement need special care.
