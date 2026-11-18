#!/bin/bash
set -euo pipefail

architecture=$(dpkg --print-architecture)
case "$architecture" in
  amd64) target=x64 ;;
  arm64) target=arm64 ;;
  *) echo "Unsupported Orca server architecture: $architecture" >&2; exit 1 ;;
esac
metadata=$(curl --fail --silent --show-error --location --retry 3 \
  https://api.github.com/repos/stablyai/orca/releases/latest | python3 -c '
import json, sys
release = json.load(sys.stdin)
asset = next(a for a in release["assets"] if a["name"] == f"orca-server-linux-{sys.argv[1]}.tar.gz")
algorithm, checksum = asset["digest"].split(":", 1)
if algorithm != "sha256":
    raise ValueError(f"Unsupported release checksum: {algorithm}")
print(release["tag_name"], checksum, asset["browser_download_url"], sep="\n")
' "$target")
mapfile -t release <<< "$metadata"
version=${release[0]}
checksum=${release[1]}
url=${release[2]}
cache=/config/.cache/orca-package
mkdir -p "$cache"
archive="$cache/orca-server-${version}-linux-${target}.tar.gz"
if [ ! -f "$archive" ] || ! printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check --status; then
  curl --fail --silent --show-error --location --retry 3 --output "$archive.tmp" \
    "$url"
  printf '%s  %s\n' "$checksum" "$archive.tmp" | sha256sum --check --status
  mv "$archive.tmp" "$archive"
fi
echo "Installing Orca server $version"
install -d -m 0755 /opt/orca-server
tar -xzf "$archive" -C /opt/orca-server --strip-components=1
ln -sf /opt/orca-server/bin/orca-ide /usr/local/bin/orca-ide
