#!/bin/bash
set -euo pipefail

# Match the Mac client's preview and keep pod replacements independent of channel updates.
commit=ad5a836cb95bf1685a2b2976762949c44f1d0828
architecture=$(dpkg --print-architecture)
case "$architecture" in
  amd64) checksum=b3ace26ae0dc896f0a50bf7dd6a5ae7c6725c57be80af69b6ceff92a8e031968 ;;
  arm64) checksum=964f7829373fcea28f14826f4f3ad1e7c49d910a6189a057eb3768d3eefb122f ;;
  *) echo "Unsupported Rex architecture: $architecture" >&2; exit 1 ;;
esac
cache=/config/.cache/rex-package
mkdir -p "$cache"
archive="$cache/rex-${commit}-${architecture}.tar.gz"
if [ ! -f "$archive" ] || ! printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check --status; then
  curl --fail --silent --show-error --location --retry 3 --output "$archive.tmp" \
    "https://blob.superlogical.com/download/rex/preview/$commit/rex-linux-${architecture}.tar.gz"
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
