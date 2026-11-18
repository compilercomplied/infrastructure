#!/usr/bin/with-contenv bash
set -euo pipefail

# Never print pairing credentials into shared pod logs; create offers with `orca-ide pair`.
# The operator proxy reaches the pod interface, so loopback binding cannot serve tailnet clients.
cd /config/workspaces
exec s6-setuidgid abc env HOME=/config \
  orca-ide serve --supervise --no-pairing --bind 0.0.0.0 --port 6768 \
  --pairing-address codex.gdario.dev --refuse-public
