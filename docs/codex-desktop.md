# Codex desktop constraints

OpenAI sign-in must happen in the remote desktop's browser because its localhost
OAuth callback must reach the application in that same desktop. Android pairing
has its own [remote-access requirements](https://learn.chatgpt.com/docs/remote-connections).

The [desktop session](../iac/workloads/selfhosted/codex-desktop/scripts/session.sh)
uses the desktop password to unlock the persistent Secret Service keyring. Changing
the Pulumi password cannot re-encrypt that keyring: recovery needs the previous
password, or applications must be authenticated again. Agent identity credentials
remain separate because application sign-in and desktop access have different owners.

A single desktop must own the browser profile, keyring, and worktrees to avoid
concurrent writers. The [workload](../iac/workloads/selfhosted/codex-desktop/)
accepts loss of this local state if its underlying volume fails; pod persistence
alone is not a recovery strategy. Cold starts depend on package repositories
because the desktop installs vendor packages at startup.

Maintenance can interrupt active Codex turns because it does not wait for agent
inactivity. Restarting Codex alone cannot refresh libraries already loaded by
other desktop processes.
