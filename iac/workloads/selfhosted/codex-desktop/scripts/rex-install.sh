#!/bin/bash
set -euo pipefail

architecture=$(dpkg --print-architecture)
case "$architecture" in
  amd64|arm64) ;;
  *) echo "Unsupported Rex architecture: $architecture" >&2; exit 1 ;;
esac
metadata=$(curl --fail --silent --show-error --location --retry 3 \
  https://blob.superlogical.com/api/releases/rex/preview | python3 -c '
import json, sys
release = json.load(sys.stdin)
asset = next(a for a in release["artifacts"] if a["filename"] == f"rex-linux-{sys.argv[1]}.tar.gz")
print(release["commit"], asset["sha256"], asset["downloadUrl"], sep="\n")
' "$architecture")
mapfile -t release <<< "$metadata"
commit=${release[0]}
checksum=${release[1]}
url=${release[2]}
cache=/config/.cache/rex-package
mkdir -p "$cache"
archive="$cache/rex-${commit}-${architecture}.tar.gz"
if [ ! -f "$archive" ] || ! printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check --status; then
  curl --fail --silent --show-error --location --retry 3 --output "$archive.tmp" "$url"
  printf '%s  %s\n' "$checksum" "$archive.tmp" | sha256sum --check --status
  mv "$archive.tmp" "$archive"
fi
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
tar -xzf "$archive" -C "$temporary" rex
"$temporary/rex" version
install -m 0755 "$temporary/rex" /usr/local/bin/rex
# OpenSSH rejects the world-writable directories used by Kubernetes ConfigMap projections.
install -o root -g root -m 0644 /opt/codex-desktop/rex-authorized-keys /etc/ssh/rex-authorized-keys

# Clients must see the same host identity after the container filesystem is replaced.
install -d -m 0700 /config/.ssh/rex-host
if [ ! -f /config/.ssh/rex-host/ssh_host_ed25519_key ]; then
  ssh-keygen -q -t ed25519 -N '' -f /config/.ssh/rex-host/ssh_host_ed25519_key
fi
