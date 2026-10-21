# Manual Forgejo configuration

The provider does not support organization webhooks. This approved exception is
managed outside the provider; teams, branch policies, and server settings remain
in IaC.

## Review webhook

Created and activated on 2026-10-21. One hook covers existing and future `home` repos.

| Field | Value |
| --- | --- |
| Organization / hook ID | `home` / `1` |
| Type / content | `forgejo` / JSON POST |
| Destination | `http://orchestrator-api.agent-dev-environment.svc.cluster.local/webhooks/forgejo` |
| Active | **true** |
| Secret | Review service's `reviewWebhookSecret`; never commit its value |
| Events | Push, PR updates/sync/comments/reviews, action-run success/failure/recovery |

The initial secret matches the service's configured HMAC-derived default. After
deployment, use the secret `reviewWebhookSecret` output of
`gdariodev/agent-dev-environment/prod`; update the hook when that value rotates.
Forgejo expands the PR/review event groups into specific events.

The service and Forgejo policy/allowlist changes are deployed. Device login
completed and dispatch resumed before hook activation. The existing hook was
enabled through organization settings without changing its destination, secret,
or event subscriptions. A documentation push and PR creation produced successful
deliveries; the controller persisted the signed push and returned HTTP 202.
Events while inactive were not queued for later review.

For a live pilot, submit a fresh `/review <full-head-sha>` on a PR and verify signed
delivery, CI gating, Job creation, and native reviewer feedback.

Inspect with `GET /api/v1/orgs/home/hooks/1`; disable with `{"active":false}` or
retire with `DELETE` at the same path. Verify its destination before changing it,
avoid duplicate hooks, and update this record after changes.
