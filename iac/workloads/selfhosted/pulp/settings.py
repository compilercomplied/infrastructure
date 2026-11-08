import os

SECRET_KEY = os.environ["PULP_SECRET_KEY"]
DATABASES = {"default": {
    "ENGINE": "django.db.backends.postgresql",
    "NAME": "pulp",
    "USER": "pulp",
    "PASSWORD": os.environ["PULP_DB_PASSWORD"],
    "HOST": os.environ.get("PULP_DB_HOST", "shared-postgres.shared-resources.svc.cluster.local"),
    "PORT": "5432",
}}
DB_ENCRYPTION_KEY = "/etc/pulp/secrets/database_fields.symmetric.key"
CONTENT_ORIGIN = "https://pulp.gdario.dev"
ALLOWED_HOSTS = ["pulp.gdario.dev", "localhost", "127.0.0.1"]
CSRF_TRUSTED_ORIGINS = ["https://pulp.gdario.dev"]
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
STATIC_URL = "/static/"
STATIC_ROOT = "/var/lib/operator/static"
REMOTE_USER_ENVIRON_NAME = "HTTP_X_REMOTE_USER"
AUTHENTICATION_BACKENDS = [
    "django.contrib.auth.backends.RemoteUserBackend",
    "django.contrib.auth.backends.ModelBackend",
    "pulpcore.backends.ObjectRolePermissionBackend",
]
REST_FRAMEWORK__DEFAULT_AUTHENTICATION_CLASSES = [
    "pulpcore.app.authentication.BasicAuthentication",
    "pulpcore.app.authentication.PulpRemoteUserAuthentication",
]
# PostgreSQL provides the task queue; Redis is only needed for optional content caching.
CACHE_ENABLED = False
