import http.cookiejar
import json
import os
import sys
import time
import urllib.error
import urllib.request

API = "http://windshift.selfhosted.svc.cluster.local"
ORIGIN = os.environ["WINDSHIFT_ORIGIN"]
WORKSPACE_ID = 2
PROVIDER_SLUG = "home-forgejo"
REPOSITORY = {
    "repository_external_id": "2",
    "repository_name": "home/homelab-iac",
    "repository_url": "https://git.gdario.dev/home/homelab-iac.git",
    "default_branch": "master",
}
AVAILABLE_REPOSITORY_PAGE_SIZE = 100
AVAILABLE_REPOSITORY_MAX_PAGES = 10
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def request(method, path, body=None):
    payload = None if body is None else json.dumps(body).encode("utf-8")
    headers = {"Origin": ORIGIN}
    if payload is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(API + path, data=payload, headers=headers, method=method)
    with opener.open(req, timeout=15) as response:
        data = response.read()
    return None if not data else json.loads(data)


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def exact_provider(provider):
    return (
        provider.get("slug") == PROVIDER_SLUG
        and provider.get("provider_type") == "gitea"
        and provider.get("auth_method") == "pat"
        and provider.get("base_url") == "https://git.gdario.dev"
        and provider.get("enabled") is True
        and provider.get("workspace_restriction_mode") == "restricted"
    )


def available_repositories(connections_path, connection_id):
    repositories = []
    for page in range(1, AVAILABLE_REPOSITORY_MAX_PAGES + 1):
        response = request(
            "GET",
            f"{connections_path}/{connection_id}/repositories/available?page={page}&per_page={AVAILABLE_REPOSITORY_PAGE_SIZE}",
        )
        current_page = response.get("repositories", [])
        require(isinstance(current_page, list), "invalid available Forgejo repositories response")
        repositories.extend(current_page)
        pagination = response.get("pagination", {})
        total_pages = pagination.get("total_pages")
        if isinstance(total_pages, int):
            require(total_pages > 0, "invalid available Forgejo repositories pagination")
            if page >= total_pages:
                return repositories
        elif len(current_page) < AVAILABLE_REPOSITORY_PAGE_SIZE:
            return repositories
    raise RuntimeError("available Forgejo repositories pagination limit exceeded")


def reconcile_sso():
    provider = {
        "slug": "authentik", "name": "Authentik", "provider_type": "oidc", "enabled": True,
        "is_default": True, "issuer_url": os.environ["OIDC_ISSUER"],
        "client_id": os.environ["OIDC_CLIENT_ID"], "client_secret": os.environ["OIDC_CLIENT_SECRET"],
        "scopes": os.environ["OIDC_SCOPES"], "auto_provision_users": True,
        "require_verified_email": True,
        "attribute_mapping": json.dumps({"email": "email", "name": "name", "given_name": "given_name", "family_name": "family_name", "username": "preferred_username", "email_verified": "email_verified"}),
    }
    existing = next((item for item in request("GET", "/api/sso/providers") if item["slug"] == "authentik"), None)
    request("POST" if existing is None else "PUT", "/api/sso/providers" if existing is None else f"/api/sso/providers/{existing['id']}", provider)


def reconcile_scm():
    providers = request("GET", "/api/admin/scm-providers")
    matches = [provider for provider in providers if provider.get("slug") == PROVIDER_SLUG]
    require(len(matches) <= 1, "conflicting SCM provider")
    provider_payload = {
        "slug": PROVIDER_SLUG, "name": "Home Forgejo", "provider_type": "gitea", "auth_method": "pat",
        "enabled": True, "is_default": False, "base_url": "https://git.gdario.dev",
        "workspace_restriction_mode": "restricted",
    }
    if not matches:
        provider = request("POST", "/api/admin/scm-providers", provider_payload)
    else:
        provider = matches[0]
        require(exact_provider(provider), "conflicting SCM provider contract")
    provider_id = provider.get("id")
    require(isinstance(provider_id, int) and provider_id > 0, "invalid SCM provider id")
    request("PUT", f"/api/admin/scm-providers/{provider_id}/allowed-workspaces", {"workspace_ids": [WORKSPACE_ID]})
    allowlist = request("GET", f"/api/admin/scm-providers/{provider_id}/allowed-workspaces")
    require(sorted(item.get("workspace_id") for item in allowlist) == [WORKSPACE_ID], "unexpected SCM workspace allowlist")

    connections_path = f"/api/workspaces/{WORKSPACE_ID}/scm-connections"
    connections = request("GET", connections_path)
    matching = [connection for connection in connections if connection.get("scm_provider_id") == provider_id]
    require(len(matching) <= 1, "conflicting Home SCM connection")
    if not matching:
        connection = request("POST", connections_path, {"scm_provider_id": provider_id})
    else:
        connection = matching[0]
        require(connection.get("workspace_id") == WORKSPACE_ID, "wrong SCM connection workspace")
    connection_id = connection.get("id")
    require(isinstance(connection_id, int) and connection_id > 0, "invalid SCM connection id")

    auth_path = f"{connections_path}/{connection_id}/auth"
    auth = request("GET", auth_path + "/status")
    if not auth.get("has_workspace_pat"):
        request("POST", auth_path + "/pat", {"personal_access_token": os.environ["WINDSHIFT_FORGEJO_PAT"]})
    auth = request("GET", auth_path + "/status")
    require(auth.get("auth_method") == "pat" and auth.get("has_workspace_pat") is True, "SCM PAT was not attached")

    available = available_repositories(connections_path, connection_id)
    available_matches = [repo for repo in available if str(repo.get("id")) == REPOSITORY["repository_external_id"] and repo.get("full_name") == REPOSITORY["repository_name"] and repo.get("clone_url") == REPOSITORY["repository_url"] and repo.get("default_branch") == REPOSITORY["default_branch"]]
    require(len(available_matches) == 1, "approved Forgejo repository is unavailable or mismatched")
    linked_path = f"{connections_path}/{connection_id}/repositories"
    linked = request("GET", linked_path)
    require(all(repo.get("repository_external_id") == REPOSITORY["repository_external_id"] and repo.get("repository_name") == REPOSITORY["repository_name"] and repo.get("repository_url") == REPOSITORY["repository_url"] and repo.get("default_branch") == REPOSITORY["default_branch"] for repo in linked), "conflicting linked repository")
    if not linked:
        request("POST", linked_path, REPOSITORY)
    linked = request("GET", linked_path)
    require(len(linked) == 1 and linked[0].get("repository_external_id") == "2" and linked[0].get("repository_name") == "home/homelab-iac" and linked[0].get("repository_url") == "https://git.gdario.dev/home/homelab-iac.git" and linked[0].get("default_branch") == "master", "SCM repository link did not converge")
    print(f"windshift SCM reconciled provider={provider_id} connection={connection_id} repository=2")


def main():
    for attempt in range(60):
        try:
            request("GET", "/readyz")
            break
        except (urllib.error.URLError, TimeoutError):
            if attempt == 59:
                raise
            time.sleep(2)

    status = request("GET", "/api/setup/status")
    if not status["setup_completed"]:
        request("POST", "/api/setup/complete", {"admin_user": {"email": os.environ["BOOTSTRAP_ADMIN_EMAIL"], "username": "gdario", "first_name": "GDario", "last_name": "Admin", "language": "en", "password": os.environ["BOOTSTRAP_ADMIN_PASSWORD"]}, "module_settings": {"time_tracking_enabled": True, "test_management_enabled": True, "workspace_managed_agents": False}})
    request("POST", "/api/auth/login", {"email_or_username": os.environ["BOOTSTRAP_ADMIN_EMAIL"], "password": os.environ["BOOTSTRAP_ADMIN_PASSWORD"], "remember_me": False})
    reconcile_sso()
    reconcile_scm()


if __name__ == "__main__":
    main()
