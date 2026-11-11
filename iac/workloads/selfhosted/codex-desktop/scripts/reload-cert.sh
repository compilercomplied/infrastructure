#!/usr/bin/with-contenv bash
set -euo pipefail

# Nginx retains certificates in memory; reload only its workers so renewal preserves the desktop session.
previous=""
while sleep 30; do
  current=$(sha256sum /config/ssl/cert.pem /config/ssl/cert.key) || continue
  if [ "$current" != "$previous" ] && [ -s /run/nginx.pid ]; then
    if nginx -t && nginx -s reload; then
      previous="$current"
    fi
  fi
done
