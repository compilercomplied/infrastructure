#!/bin/bash
set -euo pipefail

architecture=$(dpkg --print-architecture)
case "$architecture" in
  amd64|arm64) ;;
  *) echo "Unsupported Codex desktop architecture: $architecture" >&2; exit 1 ;;
esac

cache=/config/.cache/codex-package
mkdir -p "$cache"
package="$cache/chatgpt_${architecture}.deb"
curl --fail --silent --show-error --location --retry 3 --output "$package.tmp" \
  "https://persistent.oaistatic.com/codex-app-prod/linux/deb/latest/chatgpt_${architecture}.deb"
dpkg-deb --info "$package.tmp" >/dev/null
mv "$package.tmp" "$package"
echo "Installing Codex desktop $(dpkg-deb --field "$package" Version)"
export DEBIAN_FRONTEND=noninteractive
# The desktop's browser PPA is unrelated to bootstrap and can stall startup with repeated HTTP 503s.
apt_options=(-o Dir::Etc::sourcelist=/etc/apt/sources.list.d/ubuntu.sources -o Dir::Etc::sourceparts=-)
apt-get "${apt_options[@]}" update
apt-get "${apt_options[@]}" install -y --no-install-recommends "$package" gnome-keyring seahorse git openssh-client openssh-server ripgrep nodejs python3
/opt/codex-desktop/upgrade.sh
/opt/codex-desktop/rex-install.sh
/opt/codex-desktop/orca-install.sh
# Orca needs the packaged agent on the server PATH outside the desktop app.
ln -sf /usr/lib/chatgpt/resources/codex /usr/local/bin/codex
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
