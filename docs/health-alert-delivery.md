# Self-hosted health alert delivery

`SelfhostedHealthProbeFailed` is routed by Alertmanager to the Hermes webhook listener. Hermes dispatches the event to the `engineer` profile, which follows the Outline runbook at **Runbooks → Alerts → Runbook: Self-hosted health probe alert**, attempts only safe remediation, and reports the verified outcome or blocker to the `gdario` Telegram chat.

## Authentication compatibility

Hermes Agent 0.20.5 has no generic bearer-token webhook authentication. It does support GitLab's static webhook-token convention, so Alertmanager sends the shared `selfhosted.healthAlertWebhookToken` secret in `X-Gitlab-Token`.

This is a protocol compatibility bridge only: GitLab is not deployed or involved. The route is cluster-internal, is restricted to the `monitoring` namespace on port `8644`, and has its own secret. Replace this header with standard bearer authentication when Hermes releases native support.

## Verification after deployment

1. Confirm the Alertmanager and Hermes Pods are Ready.
2. Trigger a controlled `SelfhostedHealthProbeFailed` condition and wait for its five-minute `for` duration.
3. Confirm Alertmanager reports a successful webhook delivery.
4. Confirm the engineer receives the payload, references the runbook, and sends a Telegram outcome.
5. Restore the probe target and verify the resolved notification follows the same route.