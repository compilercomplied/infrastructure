# Manual Forgejo configuration

The provider does not support organization webhooks. This approved exception is
managed through the Forgejo API; teams, branch policies, and server settings remain
in IaC.

## Review webhook

Created and read back on 2026-10-21. One hook covers existing and future `home` repos.

| Field | Value |
| --- | --- |
| Organization / hook ID | `home` / `1` |
| Type / content | `forgejo` / JSON POST |
| Destination | `http://orchestrator-api.agent-dev-environment.svc.cluster.local/webhooks/forgejo` |
| Active | **false**, pending deployment |
| Secret | Review service's `reviewWebhookSecret`; never commit its value |
| Events | Push, PR updates/sync/comments/reviews, action-run success/failure/recovery |

The initial secret matches the service's configured HMAC-derived default. After
deployment, use the secret `reviewWebhookSecret` output of
`gdariodev/agent-dev-environment/prod`; update the hook when that value rotates.
Forgejo expands the PR/review event groups into specific events.

After deploying the service and Forgejo policy/allowlist changes, complete device
login, then enable hook `1` with `PATCH /api/v1/orgs/home/hooks/1` and
`{"active":true}` using an organization-owner credential. Submit a fresh
`/review <full-head-sha>` on a pilot PR and verify signed delivery and Job creation.
Events while inactive are not queued for later review.

Inspect with `GET /api/v1/orgs/home/hooks/1`; disable with `{"active":false}` or
retire with `DELETE` at the same path. Verify its destination before changing it,
avoid duplicate hooks, and update this record after changes.
