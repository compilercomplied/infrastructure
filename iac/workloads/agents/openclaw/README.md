# OpenClaw deployment decisions

The [workload](index.ts) reserves the upstream
[minimum resources](https://docs.openclaw.ai/help/faq-first-run/providers-and-hosting#what-are-the-minimum-vps-requirements-and-recommended-os)
and permits bursts into the recommended range. A personal assistant using hosted
inference does not need local model or browser capacity. The requested small data
volume is separate from the node's container image storage. Session cleanup has a
smaller budget to leave room for credentials and workspace files; upstream does
not guarantee that cleanup can reclaim all protected history.

Configuration is seeded only when missing, following the upstream
[Kubernetes pattern](https://docs.openclaw.ai/install/kubernetes#gateway-config).
OpenClaw's subscription login writes configuration as well as credentials, so a
read-only ConfigMap cannot serve as its live configuration. The persisted copy
owns subsequent application settings except proxy trust, which the init container
reconciles because it must match the infrastructure-managed ingress boundary.
Other edits to the seed affect new installations only. The whole home is backed
up because Codex state and recovery captures can live outside `.openclaw`.

[Codex subscription authentication](https://docs.openclaw.ai/providers/openai/authentication)
requires the owner's interactive sign-in after deployment. Credentials belong in
the persistent application state, outside Git. No API-key fallback is configured:
subscription access does not cover separate OpenAI Platform services, including
embedding APIs. Semantic memory search is disabled to avoid an API key requirement
or local embedding model downloads; workspace memory files remain available.

Private routing complements gateway token authentication and device pairing.
The pod receives no Kubernetes API credentials or host runtime socket because
neither is needed for this personal assistant.
