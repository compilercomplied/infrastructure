# Codex desktop access and recovery

Open `https://codex.gdario.dev` over Tailscale or
`https://192.168.50.200:30443` on the LAN and sign in as `gdario`. The LAN IP
produces a certificate hostname warning. Retrieve the desktop password with:

```sh
cd iac
mise exec -- pulumi config get codexDesktop:desktopPassword --stack local
```

Complete OpenAI sign-in in the browser **inside the remote desktop** so the
localhost callback reaches the app. For Android pairing, follow
[OpenAI's remote-access guide](https://learn.chatgpt.com/docs/remote-connections).

Changing the Pulumi desktop password does not change the persistent keyring's
password. Use the previous password to unlock it and change it in Passwords and
Keys. Losing that password can require signing in again.

Pod replacement preserves local state, but **there are no backups** to recover
from loss of the underlying volume. Cold starts also need working package
repositories.

App updates, pod restarts, and host maintenance can interrupt active Codex turns.
Maintenance does not wait for Codex to become idle. Restarting Codex alone also
leaves other desktop processes using their previously loaded libraries.

The [workload](../iac/workloads/selfhosted/codex-desktop/) owns configuration,
maintenance, and security exceptions. `mise run codex-desktop:check` checks desktop
access and recovery without signing in to OpenAI or pairing a phone.
