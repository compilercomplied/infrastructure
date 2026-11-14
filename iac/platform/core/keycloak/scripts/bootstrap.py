"""Establish durable IaC access before revoking Keycloak's temporary administrator."""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request


class BootstrapError(Exception):
    pass


class Keycloak:
    def __init__(self):
        self.url = os.environ["KEYCLOAK_URL"].rstrip("/")
        self.token = None

    def request(self, method, path, payload=None, form=False):
        headers = {}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        data = None
        if payload is not None:
            data = (urllib.parse.urlencode(payload) if form else json.dumps(payload)).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded" if form else "application/json"
        request = urllib.request.Request(self.url + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                body = response.read()
                return json.loads(body) if body else None
        except urllib.error.HTTPError as error:
            # Error bodies may include credentials or tokens; log only the operation and status.
            raise BootstrapError(f"{method} {path.split('?')[0]} returned HTTP {error.code}") from None

    def login(self, client_id, secret):
        result = self.request("POST", "/realms/master/protocol/openid-connect/token", {
            "grant_type": "client_credentials", "client_id": client_id, "client_secret": secret,
        }, form=True)
        self.token = result["access_token"]

    def clients(self, client_id):
        return self.request("GET", "/admin/realms/master/clients?" + urllib.parse.urlencode({"clientId": client_id}))


def main():
    client_id = os.environ["AUTOMATION_CLIENT_ID"]
    secret = os.environ["AUTOMATION_CLIENT_SECRET"]
    bootstrap_id = os.environ["BOOTSTRAP_CLIENT_ID"]
    if client_id == bootstrap_id:
        raise BootstrapError("Temporary and permanent client IDs must differ")
    api = Keycloak()
    try:
        api.login(client_id, secret)
        api.request("GET", "/admin/realms")
    except BootstrapError:
        # A prior attempt may have created the client but stopped before granting administrative access.
        api.login(bootstrap_id, os.environ["BOOTSTRAP_CLIENT_SECRET"])

    clients = api.clients(client_id)
    if not clients:
        api.request("POST", "/admin/realms/master/clients", {
            "clientId": client_id, "enabled": True, "protocol": "openid-connect",
            "publicClient": False, "serviceAccountsEnabled": True,
            "standardFlowEnabled": False, "implicitFlowEnabled": False,
            "directAccessGrantsEnabled": False, "fullScopeAllowed": False,
            "secret": secret,
        })
        clients = api.clients(client_id)
    if len(clients) != 1:
        raise BootstrapError("Expected exactly one automation client")
    client = clients[0]
    if not client.get("serviceAccountsEnabled") or client.get("publicClient"):
        raise BootstrapError("Existing automation client is not a confidential service account")
    # Keycloak 26.8.2 requires an explicit Admin API audience in addition to administrator roles.
    scopes = api.request("GET", "/admin/realms/master/client-scopes")
    admin_scopes = [scope for scope in scopes if scope["name"] == "kc-admin-api"]
    if len(admin_scopes) != 1:
        raise BootstrapError("Expected the built-in kc-admin-api client scope")
    api.request("PUT", f"/admin/realms/master/clients/{client['id']}/default-client-scopes/{admin_scopes[0]['id']}")
    account = api.request("GET", f"/admin/realms/master/clients/{client['id']}/service-account-user")
    role = api.request("GET", "/admin/realms/master/roles/admin")
    api.request("POST", f"/admin/realms/master/users/{account['id']}/role-mappings/realm", [role])
    api.request("POST", f"/admin/realms/master/clients/{client['id']}/scope-mappings/realm", [role])

    # A successful token request alone does not prove the permanent identity can administer Keycloak.
    api.login(client_id, secret)
    api.request("GET", "/admin/realms")
    for temporary in api.clients(bootstrap_id):
        api.request("DELETE", f"/admin/realms/master/clients/{temporary['id']}")
    if api.clients(bootstrap_id):
        raise BootstrapError("Temporary administrator was not removed")
    print("Permanent IaC administrator verified; temporary administrator removed.")


if __name__ == "__main__":
    try:
        main()
    except (BootstrapError, urllib.error.URLError, KeyError) as error:
        print(f"Keycloak bootstrap failed: {error}", file=sys.stderr)
        sys.exit(1)
