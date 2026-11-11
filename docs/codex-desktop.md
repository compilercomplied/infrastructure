# Codex desktop access and recovery

The browser desktop exists so initial sign-in and recovery do not require a pod
shell. Open `https://codex.gdario.dev` over Tailscale or
`https://192.168.50.200:30443` on the LAN and sign in as `gdario`. The certificate
is valid for `codex.gdario.dev`; accessing the LAN IP directly still produces a
hostname warning. DNS validation allows trusted certificates without exposing
the desktop publicly. Retrieve its password with:

```sh
cd iac
mise exec -- pulumi config get codexDesktop:desktopPassword --stack local
```

Complete OpenAI sign-in in the browser **inside the remote desktop** so the
localhost callback reaches the same environment. Pair Android from the app's
Connections settings. Native mobile Remote uses OpenAI's remote service; the
private browser endpoint is a separate access path, not a replacement for that
service. See [OpenAI's remote-access guide](https://learn.chatgpt.com/docs/remote-connections).

The desktop password also unlocks the persistent keyring. Changing the Pulumi
password does not re-encrypt that keyring: use its previous password to unlock
and change it in Passwords and Keys. Losing that password can require signing in
again. **Backups are intentionally disabled**, so persistence across pod
replacement does not protect against loss of the underlying volume.

Cold starts reinstall dependencies and need working package repositories. A pod
restart interrupts commands even when the saved conversation can be reopened.
Host maintenance currently detects Jobs and CI containers, not active Codex
turns. Keep these limits in mind for unattended work.

Electron's setuid sandbox is disabled because it cannot run in this container.
The container also needs AppArmor unconfined: containerd's default profile blocks
the nested bubblewrap mounts used by desktop image decoding and Codex. Without
them XFCE crashes even while Codex's sign-in window remains visible. The container
remains non-privileged; preserve that boundary when changing its configuration.
The desktop user can sudo inside it; treat access as control of the coding
environment. Preserve the pod's isolation from host mounts and credentials.
LAN source filtering relies on retaining source addresses, so changing
`externalTrafficPolicy` can invalidate the private-access boundary.

The [workload](../iac/workloads/selfhosted/codex-desktop/) owns configuration.
`mise run codex-desktop:check` exercises browser authentication, GUI autostart,
and keyring recovery across replacement; it does not authenticate to OpenAI or
pair a real phone.
