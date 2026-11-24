# Agentic review guidance

Treat fixes confined to a recently added application as low risk unless a
condition below applies.

Version-only upgrades within the same major version are normally low risk,
including minor and patch upgrades of `0.x` releases.

For version-only Renovate PRs, including Forgejo and workflow dependencies,
review the upstream changes across the version range against the configuration
and workflows this repository uses. A major version warrants closer inspection
of breaking changes and migration requirements. Approve when required CI and
relevant Pulumi preview evidence support the upgrade and no material risk or
compatibility gap remains. Escalate a specific failure, its trigger, and the
evidence or change needed to resolve it. Missing release notes or an untested
rollout alone are limitations to report.

Agents may approve PRs that only add [Forgejo repository declarations](../iac/workloads/forgejo/repositories.ts)
using the existing factory and its standard policies. Required CI must pass,
and the Pulumi preview must show only the new repositories and their standard
branch protections.

Request human review for:

- Major-version upgrades outside the version-only Renovate policy above.
- Pulumi diffs that delete or replace PVCs, databases, or stateful services.
- Forgejo changes outside the exceptions above, including changes to existing
  repositories, shared repository policies, webhooks, and application settings.
- `.forgejo/workflows/` changes beyond the version-only upgrades above.
- New bootstrap scripts, one-off scripts, or reconciliation patterns, because
  they introduce architectural risk.
- Changes that diverge from the [architecture decisions](architecture.md).
