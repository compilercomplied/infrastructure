#!/bin/bash
set -euo pipefail

version=26.1106.51428
architecture=$(dpkg --print-architecture)
case "$architecture" in
  amd64) checksum=8356a7821930b135b741347faccbc43e1692b4424c3eab710a9af56c0bebb135 ;;
  arm64) checksum=ce49ac9a1efc1b5326504b0169570b8d0973f4b18461fbcc0597bbfe5310a9bb ;;
  *) echo "Unsupported Codex desktop architecture: $architecture" >&2; exit 1 ;;
esac

# Cache the verified vendor package so pod replacement does not depend on the moving latest URL.
cache=/config/.cache/codex-package
mkdir -p "$cache"
package="$cache/chatgpt_${version}_${architecture}.deb"
if [ ! -f "$package" ] || ! printf '%s  %s\n' "$checksum" "$package" | sha256sum --check --status; then
  curl --fail --silent --show-error --location --retry 3 --output "$package.tmp" \
    "https://persistent.oaistatic.com/codex-app-prod/linux/deb/pool/main/c/chatgpt/chatgpt_${version}_${architecture}.deb"
  printf '%s  %s\n' "$checksum" "$package.tmp" | sha256sum --check --status
  mv "$package.tmp" "$package"
fi
export DEBIAN_FRONTEND=noninteractive
# The desktop's browser PPA is unrelated to bootstrap and can stall startup with repeated HTTP 503s.
apt_options=(-o Dir::Etc::sourcelist=/etc/apt/sources.list.d/ubuntu.sources -o Dir::Etc::sourceparts=-)
apt-get "${apt_options[@]}" update
apt-get "${apt_options[@]}" install -y --no-install-recommends "$package" gnome-keyring seahorse git openssh-client ripgrep nodejs python3
/opt/codex-desktop/upgrade.sh
rm -rf /var/lib/apt/lists/*

# Keep login in the visible desktop; its browser can receive the app's localhost OAuth callback.
mkdir -p /config/.config/autostart /config/workspaces
chown abc:abc /config/.cache
cat > /config/.config/autostart/codex-desktop.desktop <<'EOF'
[Desktop Entry]
Type=Application
Name=Codex desktop
Exec=/opt/codex-desktop/session.sh
Terminal=false
EOF
chown -R abc:abc /config/.config/autostart /config/workspaces
touch /run/codex-desktop-installed
