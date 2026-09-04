# Self-hosted Workloads

This page explains *how* self-hosted services are declared and exposed on the
cluster. For the high-level architecture (namespaces, security, storage, the
shared-database model), see [architecture.md](./architecture.md).

## Services

The current self-hosted applications, one module per app (all under
`iac/selfhosted/`):

| Workload | Public host | Data engine |
|----------|-------------|-------------|
| Tandoor (recipes / meal plan) | `recipes.gdario.dev` | shared PostgreSQL |
| Linkwarden (bookmarks) | `linkwarden.gdario.dev` | shared PostgreSQL |
| Grimmory (comics / books) | `grimmory.gdario.dev` | shared MariaDB |
| Outline (wiki) | `outline.gdario.dev` | Redis + MinIO (own) |
| Syncthing | `syncthing.gdario.dev` | own PVC (forward-auth middleware) |

Each app is declared through the reusable **`SelfhostedApp` component**
(`iac/library/selfhosted-component.ts`), which takes one compact config and
renders the Deployment, Service, volumes, ingress, and its database/PVC backups.
The per-app modules are therefore short and declarative rather than a pile of
raw resources. Apps that need multiple internal services (e.g. Outline, with
web + Redis + MinIO) are expressed as multiple `SelfhostedApp` components in the
same module.

### Shared databases

Several apps share a single engine per flavor instead of running their own
database server:

- **Shared PostgreSQL** (`iac/shared-resources/shared-postgres.ts`) hosts one
  logical database + dedicated user for each app (Tandoor, Authentik, Linkwarden,
  Forgejo, LiteLLM, Outline).
- **Shared MariaDB** (`iac/shared-resources/shared-mariadb.ts`) does the same
  for the MySQL-flavored app (Grimmory).

Adding an app to a shared engine means registering a database + user in the
relevant module and pointing the app at the shared in-cluster host. The
isolation model, why it exists, and how to add a database are covered in
[architecture.md → Shared-database pattern](./architecture.md#the-shared-database-pattern).

## Exposing a service

Public exposure follows one path end-to-end: `SelfhostedApp` with a public
`host` (e.g. `my-app.gdario.dev`) drives the shared ingress helper
(`iac/library/ingress.ts`), which wires the Traefik Ingress, the Let's Encrypt
annotations, an optional rate-limit middleware, and the `*-allow-traefik`
NetworkPolicy that lets the ingress reach the pods.

Two external preconditions apply to any new public hostname:

1. A matching **DNS record in Cloudflare** pointing the host at the tunnel.
2. A **route entry in `iac/selfhosted/cloudflared.ts`** so `cloudflared` answers
   that host.

Internal-only workloads (including the supporting services that back a
multi-service app) declare `exposeType: "private"` and give no host, so they are
reachable only inside the cluster.

## Notes the code encodes

A few non-obvious constraints are baked into the app configs and worth knowing
before editing one:

- **Service/env-name collisions.** Kubernetes injects `SERVICE_NAME_*` env vars
  into every pod in a namespace. A Service whose name collides with an
  application variable (e.g. `TANDOOR_PORT`) clobbers the app's own setting. The
  app modules name Services deliberately to avoid this and may still pin the
  port explicitly. See the `tandoor-recipes` module for the pattern.
- **PVCs are namespace-scoped.** An app's storage and its backup job must share
  the app's namespace, because a Pod cannot mount another namespace's PVC. The
  `SelfhostedApp` component handles this automatically for volumes it manages.
