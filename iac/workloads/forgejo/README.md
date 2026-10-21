# Forgejo

Owners push to protected branches and merge. Contributors submit PRs; Owners and
Reviewers can satisfy the required approval. The `reviewing-bot` account joins
Reviewers across all organization repositories. CI, stale-approval dismissal,
requested-review blocking, and squash merging remain required.

Add repos in [repositories.ts](./repositories.ts) with `createRepo({ name })`.
The organization defaults to `home` and repos are public unless `isPublic: false`.
Organizations must already exist. Personal repos stay under their owners' control.

Repositories use `master` as their default and only managed protected branch.
Existing repositories and teams are already adopted into Pulumi state; normal
configuration does not carry import IDs.

The manually configured organization webhook is recorded in
[manual-resources.md](./manual-resources.md).
