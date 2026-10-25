# Agentic review guidance

Treat fixes limited to a recently added application as low risk unless they meet a high-risk condition below.

Classify the following changes as high risk and request human review:

- A Pulumi diff that deletes or replaces PVCs, databases, or stateful services.
- Any Forgejo changes.
- Any changes to this repository's Forgejo workflows (`.forgejo/workflows/`).
- Changes that add bootstrap scripts, one-off scripts, or reconciliation patterns.
  These introduce architectural risk and require review.
- Changes that diverge from the desired architecture in [architecture.md](./architecture.md).
