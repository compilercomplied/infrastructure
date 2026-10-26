#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
image=${1:-$(cat "$root/iac/workloads/selfhosted/doop/image.txt")}
proxy_image=$(cat "$root/iac/workloads/selfhosted/doop/proxy-image.txt")
name="doop-smoke-$$"
config=$(mktemp)
cleanup() {
  docker rm -f "$name-proxy" "$name" >/dev/null 2>&1 || true
  rm -f "$config"
}
trap cleanup EXIT
printf '%s\n' 'map $http_upgrade $connection_upgrade { default upgrade; '\'\'' close; }' > "$config"
cat "$root/iac/workloads/selfhosted/doop/nginx.conf" >> "$config"
docker run --platform linux/amd64 -d --name "$name" \
  -e BETTER_AUTH_SECRET=local-smoke-test-only-at-least-thirty-two-characters \
  -e BETTER_AUTH_URL=http://localhost:8080 \
  -e OIDC_ISSUER=https://idp.invalid -e OIDC_CLIENT_ID=test -e OIDC_CLIENT_SECRET=test \
  "$image" >/dev/null
docker run -d --name "$name-proxy" --network "container:$name" \
  -v "$config:/etc/nginx/conf.d/default.conf:ro" "$proxy_image" >/dev/null
for attempt in $(seq 1 60); do
  if docker exec "$name" node -e "fetch('http://localhost:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    break
  fi
  if [ "$attempt" = 60 ]; then
    docker logs "$name"
    docker logs "$name-proxy"
    exit 1
  fi
  sleep 1
done
docker exec -i "$name" node --input-type=module <<'JS'
import assert from 'node:assert/strict';
const base = 'http://localhost:8080';
assert.equal((await fetch('http://[::1]:8080/healthz')).status, 200);
for (const path of [
  '/api/auth/sign-up/email', '/api/auth/sign-up/email/', '/api/auth/sign-in/email',
  '/api/auth/%73ign-up/email', '/api/auth/request-password-reset',
  '/api/auth/reset-password', '/api/auth/set-password', '/api/auth/change-password',
]) {
  const r = await fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'outsider@example.com', password: 'test-password-1234', name: 'Outsider' }),
  });
  assert.equal(r.status, 403, path);
}
const check = await fetch(base + '/api/account-exists', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'outsider@example.com' }),
});
assert.equal((await check.json()).exists, false);
const oidc = await (await fetch(base + '/api/oidc-config')).json();
assert.equal(oidc.enabled, true);
const mcp = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
assert.equal(mcp.status, 401);
const { default: puppeteer } = await import('puppeteer-core');
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });
  await page.setContent('<html><body><h1>Phone screen</h1></body></html>');
  assert.ok((await page.screenshot()).length > 1000);
} finally { await browser.close(); }
console.log('Headless Chromium rendered a phone-sized screen.');
console.log('Proxy smoke test passed: password signup/login blocked; no outsider account; OIDC and MCP reachable.');
JS
