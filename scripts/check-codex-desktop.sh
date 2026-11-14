#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
source_dir="$root/iac/workloads/selfhosted/codex-desktop"
image=$(sed -n 's/^[[:space:]]*image: "\([^"]*\)",$/\1/p' "$source_dir/index.ts")
platform=${CODEX_TEST_PLATFORM:-linux/amd64}
# Resolve the platform manifest to avoid classic Docker's conflicting multi-architecture digest cache.
manifest=$(docker buildx imagetools inspect "$image" --format '{{json .Manifest}}' |
  CODEX_TEST_PLATFORM="$platform" node -e '
    let data = "";
    process.stdin.on("data", chunk => data += chunk);
    process.stdin.on("end", () => {
      const [os, architecture] = process.env.CODEX_TEST_PLATFORM.split("/");
      const entry = JSON.parse(data).manifests.find(m => m.platform.os === os && m.platform.architecture === architecture);
      if (!entry) throw new Error("Image has no manifest for " + process.env.CODEX_TEST_PLATFORM);
      console.log(entry.digest);
    });')
image="${image%@*}@$manifest"
name="codex-desktop-smoke-$$"
volume="$name-home"
init_dir=$(mktemp -d)
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  rm -rf "$init_dir"
}
trap cleanup EXIT
cp "$source_dir/scripts/init.sh" "$init_dir/"
chmod +x "$init_dir/init.sh"
mkdir -p "$init_dir/ssl" "$init_dir/services"
cp "$source_dir/scripts/reload-cert.sh" "$init_dir/services/reload-cert"
cp "$source_dir/scripts/maintenance.sh" "$init_dir/services/apt-maintenance"
chmod +x "$init_dir/services/"*
make_certificate() {
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost \
    -addext subjectAltName=DNS:localhost -keyout "$init_dir/ssl/cert.key" \
    -out "$init_dir/ssl/cert.pem" >/dev/null 2>&1
}
make_certificate
docker volume create "$volume" >/dev/null

start() {
  docker run --platform "$platform" -d --name "$name" \
    --security-opt apparmor=unconfined \
    --shm-size=1g -p 127.0.0.1::3001 \
    -e PUID=1000 -e PGID=1000 -e TZ=Europe/Madrid -e CUSTOM_USER=gdario -e PASSWORD=smoke-test-only \
    -e PIXELFLUX_WAYLAND=false \
    -v "$volume:/config" -v "$init_dir:/custom-cont-init.d:ro" \
    -v "$init_dir/ssl:/config/ssl:ro" -v "$init_dir/services:/custom-services.d:ro" \
    -v "$source_dir/scripts:/opt/codex-desktop:ro" "$image" >/dev/null
  for attempt in $(seq 1 120); do
    if docker exec "$name" bash -c \
      'test -f /run/codex-desktop-installed && pgrep -u abc -x ChatGPT >/dev/null && pgrep -u abc -x xfce4-session >/dev/null && pgrep -u abc -x xfwm4 >/dev/null' 2>/dev/null; then
      port=$(docker port "$name" 3001/tcp | sed 's/.*://')
      if [ "$(curl -s --cacert "$init_dir/ssl/cert.pem" -o /dev/null -w '%{http_code}' "https://localhost:$port/")" = 401 ] &&
        [ "$(curl -s --cacert "$init_dir/ssl/cert.pem" -u gdario:smoke-test-only -o /dev/null -w '%{http_code}' "https://localhost:$port/")" = 200 ]; then
        return
      fi
    fi
    sleep 5
  done
  docker logs --tail 50 "$name"
  docker exec "$name" tail -30 /config/.cache/codex-desktop.log || true
  echo "Desktop did not become ready" >&2
  return 1
}

start
docker exec -u abc "$name" sh -c 'printf preserved > /config/workspaces/restart-check'
docker exec "$name" test -s /config/.local/share/keyrings/login.keyring
docker rm -f "$name" >/dev/null
start
docker exec "$name" grep -qx preserved /config/workspaces/restart-check
docker exec "$name" test -s /config/.local/share/keyrings/login.keyring
# Simulate an older running client without changing installed packages or waiting for a new vendor release.
desktop_pid=$(docker exec "$name" pgrep -u abc -x xfce4-session)
app_pid=$(docker exec "$name" pgrep -o -u abc -x ChatGPT)
docker exec -u abc "$name" sh -c 'printf 0 > /config/.cache/codex-desktop-version'
if ! docker exec "$name" /opt/codex-desktop/upgrade.sh > "$init_dir/upgrade.log" 2>&1; then
  cat "$init_dir/upgrade.log"
  exit 1
fi
restarted=false
for attempt in $(seq 1 30); do
  sleep 2
  current_pid=$(docker exec "$name" pgrep -o -u abc -x ChatGPT || true)
  if [ -n "$current_pid" ] && [ "$current_pid" != "$app_pid" ] &&
    docker exec "$name" bash -c 'test "$(cat /config/.cache/codex-desktop-version)" = "$(dpkg-query -W -f="\${Version}" chatgpt)"'; then
    restarted=true
    break
  fi
done
test "$restarted" = true
test "$(docker exec "$name" pgrep -u abc -x xfce4-session)" = "$desktop_pid"
docker logs "$name" 2>&1 | rg 'Next Codex desktop APT maintenance: .*T04:00:00\+0[12]:00' >/dev/null
docker exec -i -u abc "$name" python3 <<'PY'
import os
import subprocess
pid = subprocess.check_output(["pgrep", "-u", "abc", "-x", "xfce4-session"], text=True).strip()
with open(f"/proc/{pid}/environ") as source:
    session = dict(item.split("=", 1) for item in source.read().split("\0") if "=" in item)
result = subprocess.check_output([
    "gdbus", "call", "--session", "--dest", "org.freedesktop.secrets",
    "--object-path", "/org/freedesktop/secrets/collection/login",
    "--method", "org.freedesktop.DBus.Properties.Get", "org.freedesktop.Secret.Collection", "Locked",
], env={**os.environ, **session}, text=True, timeout=15)
assert "false" in result, f"Persistent keyring is locked: {result}"
PY
# The sign-in window can remain visible while XFCE crashes and is restarted in the background.
session_pid=$(docker exec "$name" pgrep -u abc -x xfce4-session)
make_certificate
renewed=false
for attempt in $(seq 1 12); do
  sleep 5
  if curl --silent --cacert "$init_dir/ssl/cert.pem" -u gdario:smoke-test-only \
    --fail --output /dev/null "https://localhost:$port/"; then
    renewed=true
    break
  fi
done
test "$renewed" = true
for attempt in $(seq 1 12); do
  sleep 5
  test "$(docker exec "$name" pgrep -u abc -x xfce4-session)" = "$session_pid"
  docker exec "$name" pgrep -u abc -x xfwm4 >/dev/null
done
echo 'Passed: startup upgrades, maintenance app restart without desktop replacement, authenticated TLS, certificate renewal, and persistent unlocked state.'
