# Agentic review guidance

Treat fixes confined to a recently added application as low risk unless a
condition below applies.

Version-only upgrades within the same major version are normally low risk,
including minor and patch upgrades of `0.x` releases. For Renovate, approve when
required CI passes; this also applies to version-only Forgejo and workflow
upgrades. Escalate concrete breaking changes, security risks, or destructive
Pulumi diffs. Missing release notes or unverified compatibility with an unchanged
companion component alone do not require escalation.

Request human review for:

- Major-version upgrades.
- Pulumi diffs that delete or replace PVCs, databases, or stateful services.
- Forgejo or `.forgejo/workflows/` changes beyond the version-only upgrades above.
- New bootstrap scripts, one-off scripts, or reconciliation patterns, because
  they introduce architectural risk.
- Changes that diverge from the [architecture decisions](architecture.md).
