# Agentic review guidance

Treat fixes limited to a recently added application as low risk unless they meet a high-risk condition below.

Version-only upgrades that keep the same major version are normally low risk.
For Renovate, approve when required CI passes, including version-only upgrades
in Forgejo and its workflows. This includes minor and patch upgrades of `0.x` releases,
such as `0.6.5` to `0.6.7`. Do not approve blindly: escalate concrete risks,
including known breaking changes, security issues, or destructive Pulumi diffs.
Missing release notes or unverified compatibility with an unchanged companion
component are not, by themselves, reasons to escalate these upgrades. Apply the
high-risk conditions below to independent changes or risks beyond the version bump.

Classify the following changes as high risk and request human review:

- Upgrades that change the major version.
- A Pulumi diff that deletes or replaces PVCs, databases, or stateful services.
- Forgejo changes other than version-only Renovate upgrades covered above.
- Changes to this repository's Forgejo workflows (`.forgejo/workflows/`) other
  than version-only Renovate upgrades covered above.
- Changes that add bootstrap scripts, one-off scripts, or reconciliation patterns.
  These introduce architectural risk and require review.
- Changes that diverge from the desired architecture in [architecture.md](./architecture.md).
