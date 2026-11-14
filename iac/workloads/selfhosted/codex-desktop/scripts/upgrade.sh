#!/bin/bash
set -euo pipefail

# Serialize manual checks with scheduled maintenance without granting the pod Kubernetes access.
exec 9>/run/codex-desktop-apt.lock
flock -w 300 9

sources=$(mktemp -d /run/codex-desktop-apt.XXXXXX)
cleanup() {
  rm -rf "$sources"
  rm -f /run/codex-desktop-upgrading
}
trap cleanup EXIT
chmod 0755 "$sources"
# The browser PPA has stalled bootstrap; OpenAI's signed source is needed for app updates.
cp /etc/apt/sources.list.d/ubuntu.sources /etc/apt/sources.list.d/chatgpt.sources "$sources/"
apt_options=(
  -o Dir::Etc::sourcelist=/dev/null
  -o "Dir::Etc::sourceparts=$sources"
  -o APT::Update::Error-Mode=any
  -o Acquire::Retries=3
  -o DPkg::Lock::Timeout=300
)
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l
before=$(dpkg-query -W -f='${Version}' chatgpt)
# A previous partial upgrade can change the installed version without restarting the running app.
if [ -f /run/codex-desktop-installed ] && [ -s /config/.cache/codex-desktop-version ]; then
  before=$(cat /config/.cache/codex-desktop-version)
fi
touch /run/codex-desktop-upgrading
apt-get "${apt_options[@]}" update
# Keep the desktop's configuration and forbid package removals during unattended upgrades.
apt-get "${apt_options[@]}" -y --with-new-pkgs --no-remove \
  -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade
apt-get clean
after=$(dpkg-query -W -f='${Version}' chatgpt)
echo "Codex desktop APT maintenance succeeded: chatgpt $before -> $after"

if [ "$before" != "$after" ] && [ -f /run/codex-desktop-installed ]; then
  # The desktop session launcher preserves its D-Bus/keyring environment when it relaunches the app.
  pkill -TERM -u abc -x ChatGPT || [ "$?" -eq 1 ]
fi
