#!/usr/bin/with-contenv bash
set -euo pipefail

# Bootstrap upgrades before the desktop starts; the daily service must not race that install.
while [ ! -f /run/codex-desktop-installed ]; do sleep 5; done

while true; do
  now=$(date +%s)
  next=$(date -d 'today 04:00' +%s)
  if [ "$next" -le "$now" ]; then
    next=$(date -d 'tomorrow 04:00' +%s)
  fi
  echo "Next Codex desktop APT maintenance: $(date -d "@$next" --iso-8601=seconds)"
  sleep "$((next - now))"
  # Retry the following night rather than repeatedly interrupting work after a repository failure.
  if ! /opt/codex-desktop/upgrade.sh; then
    echo 'Codex desktop APT maintenance failed; retrying at the next daily window' >&2
  fi
done
