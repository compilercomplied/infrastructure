# Deploy re-trigger

PR #86 (docker runner label) merged as 0628886. Its push-triggered Pulumi run 287 was
cancelled mid-update when the forgejo-runner Deployment rollout replaced the runner pod
executing task 329, so no completed deploy existed for that commit.

This commit is an intentional no-IaC-change deploy re-trigger so the repository workflow
runs pulumi up to a settled state. Safe to delete once the runner advertises docker.
