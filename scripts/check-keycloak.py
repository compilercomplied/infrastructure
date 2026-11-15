#!/usr/bin/env python3
"""Exercise the bootstrap against disposable Keycloak and PostgreSQL containers."""

import importlib.util
import base64
import http.client
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import time
import urllib.error
import urllib.request
import uuid


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "iac/platform/core/keycloak"
IMAGE = re.search(r'keycloakImage = "([^"]+)"', (SOURCE / "index.ts").read_text())[1]
PYTHON_IMAGE = re.search(r'bootstrapImage = "([^"]+)"', (SOURCE / "index.ts").read_text())[1]
PREFIX = "keycloak-check-" + uuid.uuid4().hex[:10]


def docker(*args, **kwargs):
    return subprocess.run(["docker", *args], check=True, text=True, capture_output=True, **kwargs).stdout.strip()


def wait_ready(url):
    deadline = time.monotonic() + 240
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url + "/health/ready", timeout=3) as response:
                if response.status == 200:
                    return
        except (urllib.error.URLError, TimeoutError, http.client.HTTPException, ConnectionError):
            pass
        time.sleep(2)
    raise RuntimeError("Disposable Keycloak did not become ready")


def main():
    db_password = secrets.token_hex(24)
    temporary_secret = secrets.token_hex(24)
    permanent_secret = secrets.token_hex(24)
    try:
        docker("network", "create", PREFIX)
        docker("run", "-d", "--name", PREFIX + "-db", "--network", PREFIX,
               "-e", "POSTGRES_PASSWORD=" + db_password, "postgres:16-alpine")
        for attempt in range(60):
            if subprocess.run(["docker", "exec", PREFIX + "-db", "pg_isready", "-U", "postgres"], capture_output=True).returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError("Disposable PostgreSQL did not become ready")
        sql = (SOURCE / "scripts/postgres_bootstrap.sql").read_text()
        for _ in range(2):
            docker("exec", "-i", PREFIX + "-db", "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1",
                   "-v", "db_name=keycloak", "-v", "db_user=keycloak", "-v", "db_password=" + db_password, input=sql)
        docker("run", "-d", "--name", PREFIX + "-server", "--network", PREFIX,
               "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
               "-p", "127.0.0.1::9000", "-p", "127.0.0.1::8080", "--memory", "1g", "--cpus", "2",
               "-e", "KC_DB=postgres", "-e", f"KC_DB_URL=jdbc:postgresql://{PREFIX}-db:5432/keycloak",
               "-e", "KC_DB_USERNAME=keycloak", "-e", "KC_DB_PASSWORD=" + db_password,
               "-e", "KC_HOSTNAME=http://localhost", "-e", "KC_HTTP_ENABLED=true",
               "-e", "KC_PROXY_HEADERS=xforwarded", "-e", "KC_HEALTH_ENABLED=true", "-e", "KC_METRICS_ENABLED=true",
               "-e", "KC_CACHE=local", "-e", "KC_BOOTSTRAP_ADMIN_CLIENT_ID=bootstrap-iac",
               "-e", "KC_BOOTSTRAP_ADMIN_CLIENT_SECRET=" + temporary_secret, IMAGE, "start")
        ports = json.loads(docker("inspect", "--format", "{{json .NetworkSettings.Ports}}", PREFIX + "-server"))
        base = "http://127.0.0.1:" + ports["8080/tcp"][0]["HostPort"]
        health = "http://127.0.0.1:" + ports["9000/tcp"][0]["HostPort"]
        wait_ready(health)

        def bootstrap(secret=permanent_secret, success=True, interrupted=False):
            args = ["docker", "run", "--rm", "--network", PREFIX, "--read-only", "--user", "1000:1000",
                    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                    "-v", f"{SOURCE / 'scripts/bootstrap.py'}:/bootstrap.py:ro",
                    "-e", f"KEYCLOAK_URL=http://{PREFIX}-server:8080",
                    "-e", "AUTOMATION_CLIENT_ID=pulumi", "-e", "AUTOMATION_CLIENT_SECRET=" + secret,
                    "-e", "BOOTSTRAP_CLIENT_ID=bootstrap-iac", "-e", "BOOTSTRAP_CLIENT_SECRET=" + temporary_secret,
                    PYTHON_IMAGE, "python", "-B"]
            if interrupted:
                args += ["-c", """
import sys
sys.path.insert(0, '/')
import bootstrap
original = bootstrap.Keycloak.request
def interrupt(self, method, path, payload=None, form=False):
    if method == 'PUT' and '/default-client-scopes/' in path:
        raise bootstrap.BootstrapError('Simulated interruption before administrator permissions')
    return original(self, method, path, payload, form)
bootstrap.Keycloak.request = interrupt
bootstrap.main()
"""]
            else:
                args += ["/bootstrap.py"]
            result = subprocess.run(args, capture_output=True, text=True)
            assert (result.returncode == 0) == success, result.stdout + result.stderr
            assert permanent_secret not in result.stdout + result.stderr
            assert temporary_secret not in result.stdout + result.stderr

        bootstrap(success=False, interrupted=True)
        bootstrap()
        bootstrap()
        bootstrap(secret="wrong-secret", success=False)
        docker("restart", PREFIX + "-server")
        # Docker may allocate new ephemeral host ports when restarting the container.
        ports = json.loads(docker("inspect", "--format", "{{json .NetworkSettings.Ports}}", PREFIX + "-server"))
        base = "http://127.0.0.1:" + ports["8080/tcp"][0]["HostPort"]
        health = "http://127.0.0.1:" + ports["9000/tcp"][0]["HostPort"]
        wait_ready(health)
        bootstrap()

        spec = importlib.util.spec_from_file_location("keycloak_bootstrap", SOURCE / "scripts/bootstrap.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        os.environ["KEYCLOAK_URL"] = base
        api = module.Keycloak()
        api.login("pulumi", permanent_secret)
        assert api.clients("bootstrap-iac") == []
        assert len(api.clients("pulumi")) == 1
        # The future Pulumi provider needs administrative API access, not just successful authentication.
        api.request("POST", "/admin/realms", {"realm": "provider-check", "enabled": True,
                    "sslRequired": "none", "attributes": {"frontendUrl": base}})
        check_application_tokens(api, module, base)
        api.request("DELETE", "/admin/realms/provider-check")
        try:
            api.login("bootstrap-iac", temporary_secret)
            raise AssertionError("Temporary administrator can still authenticate")
        except module.BootstrapError:
            pass
        print("Validated database reruns, interrupted-bootstrap recovery, permanent administration, temporary-admin revocation, restart persistence, and failure on invalid credentials.")
    finally:
        for suffix in ("-server", "-db"):
            subprocess.run(["docker", "rm", "-f", "-v", PREFIX + suffix], capture_output=True)
        subprocess.run(["docker", "network", "rm", PREFIX], capture_output=True)


def check_application_tokens(api, module, base):
    realm = "/admin/realms/provider-check"
    lifespan = re.search(r'accessTokenLifespan: "(\d+)"', (SOURCE / "identities.ts").read_text())[1]
    api.request("POST", realm + "/clients", {
        "clientId": "memos-check", "secret": "disposable-client-secret", "enabled": True,
        "standardFlowEnabled": True, "publicClient": False, "directAccessGrantsEnabled": True,
        "redirectUris": [base + "/callback"], "attributes": {"access.token.lifespan": lifespan},
    })
    client = api.request("GET", realm + "/clients?clientId=memos-check")[0]
    scopes = api.request("GET", realm + "/client-scopes")
    basic = next(scope for scope in scopes if scope["name"] == "basic")
    api.request("PUT", realm + f"/clients/{client['id']}/default-client-scopes/{basic['id']}")
    api.request("POST", realm + "/users", {
        "username": "pilot", "enabled": True, "firstName": "Pilot", "lastName": "Test",
        "email": "pilot@example.invalid", "emailVerified": True,
        "credentials": [{"type": "password", "value": "disposable-test-password", "temporary": False}],
    })

    # A disposable password grant exercises the same token generator without a
    # browser or TLS proxy. Production browser clients keep this grant disabled.
    oidc = "/realms/provider-check/protocol/openid-connect"
    unauthenticated = module.Keycloak()
    tokens = unauthenticated.request("POST", oidc + "/token", {
        "grant_type": "password", "client_id": "memos-check", "client_secret": "disposable-client-secret",
        "username": "pilot", "password": "disposable-test-password", "scope": "openid profile email",
    }, form=True)
    assert 3500 < tokens["expires_in"] <= 3600
    access = json.loads(base64.urlsafe_b64decode(tokens["access_token"].split(".")[1] + "=="))
    assert access["sub"] and access["sub"] != "a" * 64
    unauthenticated.token = tokens["access_token"]
    userinfo = unauthenticated.request("GET", oidc + "/userinfo")
    assert userinfo["sub"] == access["sub"]
    print("Validated real Keycloak token issuance, numeric client expiry, native subject and userinfo.")


if __name__ == "__main__":
    main()
