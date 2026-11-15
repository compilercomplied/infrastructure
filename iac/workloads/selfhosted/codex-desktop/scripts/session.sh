#!/bin/bash
set -euo pipefail

# The desktop password also unlocks the persistent Secret Service keyring after pod replacement.
# Preserve XFCE's D-Bus session; with-contenv would remove it and strand the keyring on another bus.
gnome-keyring-daemon --unlock --daemonize < /run/s6/container_environment/PASSWORD
eval "$(gnome-keyring-daemon --start --components=secrets)"
# s6 may strip the desktop environment; restore only agent login settings while preserving D-Bus.
for variable in AGENT_IDENTITY_ISSUER AGENT_IDENTITY_ACCOUNT_URL AGENT_IDENTITY_INSTRUCTIONS AGENT_IDENTITY_USERNAME AGENT_IDENTITY_PASSWORD; do
  if [ -f "/run/s6/container_environment/$variable" ]; then
    export "$variable=$(cat "/run/s6/container_environment/$variable")"
  fi
done
xset s off || true
xset -dpms || true

while true; do
  # A crashed app must not relaunch while dpkg is replacing its files.
  while [ -f /run/codex-desktop-upgrading ]; do sleep 2; done
  dpkg-query -W -f='${Version}' chatgpt > /config/.cache/codex-desktop-version
  # Electron's setuid sandbox is unavailable in this container; the pod is the outer isolation boundary.
  chatgpt --no-sandbox --disable-gpu >> /config/.cache/codex-desktop.log 2>&1 || true
  sleep 5
done
