import http.cookiejar
import json
import os
import time
import urllib.error
import urllib.request


API = "http://windshift.selfhosted.svc.cluster.local"
ORIGIN = os.environ["WINDSHIFT_ORIGIN"]
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def request(method, path, body=None):
    payload = None if body is None else json.dumps(body).encode("utf-8")
    headers = {"Origin": ORIGIN}
    if payload is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(API + path, data=payload, headers=headers, method=method)
    with opener.open(req, timeout=15) as response:
        data = response.read()
    if not data:
        return None
    try:
        return json.loads(data)
    except json.JSONDecodeError:
        return data.decode("utf-8")


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
    request("POST", "/api/setup/complete", {
        "admin_user": {
            "email": os.environ["BOOTSTRAP_ADMIN_EMAIL"],
            "username": "gdario",
            "first_name": "GDario",
            "last_name": "Admin",
            "language": "en",
            "password": os.environ["BOOTSTRAP_ADMIN_PASSWORD"],
        },
        "module_settings": {
            "time_tracking_enabled": True,
            "test_management_enabled": True,
            "workspace_managed_agents": False,
        },
    })

request("POST", "/api/auth/login", {
    "email_or_username": os.environ["BOOTSTRAP_ADMIN_EMAIL"],
    "password": os.environ["BOOTSTRAP_ADMIN_PASSWORD"],
    "remember_me": False,
})

provider = {
    "slug": "authentik",
    "name": "Authentik",
    "provider_type": "oidc",
    "enabled": True,
    "is_default": True,
    "issuer_url": os.environ["OIDC_ISSUER"],
    "client_id": os.environ["OIDC_CLIENT_ID"],
    "client_secret": os.environ["OIDC_CLIENT_SECRET"],
    "scopes": os.environ["OIDC_SCOPES"],
    "auto_provision_users": True,
    "require_verified_email": True,
    "attribute_mapping": json.dumps({
        "email": "email",
        "name": "name",
        "given_name": "given_name",
        "family_name": "family_name",
        "username": "preferred_username",
        "email_verified": "email_verified",
    }),
}

existing = next((item for item in request("GET", "/api/sso/providers") if item["slug"] == "authentik"), None)
if existing is None:
    request("POST", "/api/sso/providers", provider)
else:
    request("PUT", f"/api/sso/providers/{existing['id']}", provider)
