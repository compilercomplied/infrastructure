# Forgejo

Manage organization repos and permissions through IaC so every repo follows the
same rules. Owners approve and merge changes; Contributors work through pull
requests. Repos share the same CI checks, branch protection, and squash merging.

Add repos in [repositories.ts](./repositories.ts) with `createRepo({ name })`.
The organization defaults to `home` and repos are public unless `isPublic: false`.
Organizations must already exist. Personal repos stay under their owners' control.
