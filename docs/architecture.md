# Cluster Architecture

This document is the high-level map of the homelab k3s cluster. It describes the
*why* and the *where*: which namespaces exist and what each one is for, the
security and storage patterns they all follow, and how a workload travels from
"repo" to "serving traffic." It is deliberately **not** a resource-by-resource
inventory.

The single source of truth for concrete detail is the code. Every section points
to the Pulumi module that defines what it describes; nothing here repeats
resource definitions. If this document and the code disagree, the code wins.

The cluster is defined as code in the Pulumi project under `iac/`. The project
is wrapped by **mise**, which manages the toolchain (pulumi, node) and the
project lifecycle tasks (`project-setup`, `preview-deployment`). See
`mise.toml` for the exact tasks — in short, one command prepares a fresh checkout
and another runs the validation dry-run against the local stack.

> **Operation guardrail:** this stack is **preview-only**. We never run
> `pulumi up` by hand. Changes land through a pull request, and the CI preview
> run on that PR is the source of truth that the diff is safe. The repository
> lives on the Code Forge at `git.gdario.dev` (`home/homelab-iac`).

---

## Cluster topology & ingress

The cluster is a single-node k3s behind a **Cloudflare Tunnel**. There is no
public IP and no inbound ports: a `cloudflared` agent inside the cluster keeps
an outbound-only connection to Cloudflare's edge, and public hostnames are
served through it.

Traffic flows `Internet → Cloudflare Tunnel → Traefik (kube-system) → pod`.
Traefik is the ingress controller. TLS is automated:

- **Public hostnames** (`*.gdario.dev`) get Let's Encrypt certificates via
  `cert-manager` (`letsencrypt-prod` cluster issuer).
- **Internal-only hostnames** (`.home.arpa`) skip the public issuer because they
  are only reachable over the VPN.

CoreDNS is customized to rewrite the cluster's internal hostnames straight to
the Traefik service, so any pod can reach any workload by hostname without
leaving the cluster and coming back through the tunnel. The rewrite map lives in
`iac/selfhosted/coredns.ts`.

Every public Service is exposed through the shared ingress helper in
`iac/library/ingress.ts`. The helper builds the Ingress, wires the Let's
Encrypt + Traefik annotations, optionally attaches a rate-limit middleware, and
— because of the default-deny network policy (see Security) — also creates the
`*-allow-traefik` NetworkPolicy that lets the controller actually reach the
back-end pods. Using this helper is how a workload becomes reachable from the
outside; it is baked into the `SelfhostedApp` component.

The authoritative list of public hostnames is the CoreDNS rewrite block plus the
ingress-helper calls, but at a glance:

| Host | Workload | Namespace |
|------|----------|-----------|
| `auth.gdario.dev` | Authentik (SSO) | `infrastructure` |
| `git.gdario.dev` | Forgejo + CI runner | `forgejo` |
| `recipes.gdario.dev` | Tandoor (recipes / meal plan) | `selfhosted` |
| `linkwarden.gdario.dev` | Linkwarden (bookmarks) | `selfhosted` |
| `grimmory.gdario.dev` | Grimmory (comics / books) | `selfhosted` |
| `outline.gdario.dev` | Outline (wiki) | `selfhosted` |
| `syncthing.gdario.dev` | Syncthing | `selfhosted` |
| `grafana.gdario.dev` | Grafana | `monitoring` |
| `litellm.gdario.dev` | LiteLLM (LLM gateway) | `infrastructure` |
| `hermes.gdario.dev` / `hermes-api.gdario.dev` | Hermes Agent | `agent-sidekicks` |

---

## Namespaces and their purpose

The cluster is partitioned by **workload purpose**, not by team or by repo. Each
namespace carries its own default-deny network policy (see Security).

| Namespace | Purpose | What lives there |
|-----------|---------|------------------|
| `kube-system` | Cluster plumbing | Traefik ingress, CoreDNS rewrite, `cert-manager` solver, Kata runtime, sysctl-tuner, image-gc cron |
| `monitoring` | Observability | Prometheus + Loki (storage), Alloy (collection), Grafana (visualization), PVC + DeepSeek-budget exporters |
| `shared-resources` | Shared stateful foundations | The shared PostgreSQL and shared MariaDB clusters and their access policies |
| `selfhosted` | User-facing apps | Tandoor, Linkwarden, Grimmory, Outline, Syncthing, the `cloudflared` tunnel agent |
| `infrastructure` | Core platform | Authentik (SSO) + its Redis, LiteLLM proxy, Kata deployment |
| `forgejo` | Code forge | Forgejo (git) + Forgejo Actions runner |
| `agent-sidekicks` | AI agent tooling | The MCP servers (Tandoor, Outline, Grafana, Kubernetes) and Hermes Agent |
| `agents` / `agents-control-plane` / `agent-sandbox` | Sandboxed agents | Agent RBAC + control-plane, and the Kata-isolated sandbox for untrusted code |

The namespace entry points live across `iac/` (each `configure*`/index file), and
the agent-management namespaces are centralized in
`iac/modules/agents/namespaces.ts`.

### Why this split

Each namespace is a security boundary. Apps that take input from the internet
(`selfhosted`) are separated from platform services (`infrastructure`) and from
anything that can *execute* agent-generated code (`agent-sandbox`,
`agent-sidekicks`). The split trades away a little operational simplicity for
strong isolation precisely where isolation matters; well-understood, stable
state can be consolidate across apps via the shared-database pattern instead of
copying a whole engine per app.

---

## Security model

The cluster is **zero-trust and default-deny** for network ingress: inside a
namespace, a pod accepts no inbound traffic unless a `NetworkPolicy` explicitly
opens a path. There is no implicit "anything in the same namespace may connect."

The baseline policy is applied per namespace by
`configureNamespaceSecurity(...)` in `iac/selfhosted/security.ts`. Per namespace
it creates:

- a **default-deny** ingress policy (matches every pod, denies all inbound),
- an **allow-monitoring-scrape** policy so Prometheus/Alloy in `monitoring` can
  scrape metric endpoints,
- an **allow-cert-manager-solver** policy so ACME HTTP-01 challenge pods are
  reachable while a certificate is in flight.

On top of the baseline, specific pods declare **label-based** grants. A shared
label set (`Labels.Network` in `iac/selfhosted/labels.ts`) flags pods authorized
to reach shared infrastructure, and the shared service's own NetworkPolicy only
admits pods carrying the matching label:

- `network/allow-postgres` — may connect to the shared PostgreSQL.
- `network/allow-mariadb` — may connect to the shared MariaDB.
- `network/allow-authentik` — may reach the Authentik server for OIDC.

So network access is opt-in, per pod, enforced at the resource it wants to
reach — the default-deny posture stays intact while exactly the needed links are
opened. Cross-namespace rules constrain both the *source namespace* and the
*source pod label*, so a grant reads like "only pods of type X in namespace Y may
connect to this."

> **Migration bridge (temporary):** a set of permissive *bridge* policies
> (`iac/shared-resources/bridge-network-policies.ts`) currently allows broader
> cross-namespace traffic between the legacy and current layouts. These exist to
> keep the migration non-breaking and are slated for removal once fine-grained
> policies cover every path.

Authentication to the apps is centralized in **Authentik** (`auth.gdario.dev`)
as the OIDC provider, with **Google OAuth** as the identity source. Self-service
signup is off — an administrator provisions users in Authentik up front, and
those users authenticate with their existing Google accounts. Each integrating
app is registered as an OIDC client in `iac/infrastructure/authentik.ts` and
its `templates/authentik-blueprints.yaml`.

Two services intentionally bypass OIDC and authenticate with a bearer token
instead of an SSO login: Forgejo (which has its own user/SSH model) and the
Hermes Agent API endpoint `hermes-api.gdario.dev`, which is meant for
OpenAI-compatible client apps using an API key.

---

## Storage

State lives in the cluster on **PersistentVolumeClaims** backed by the k3s
`local-path` provisioner. Two patterns are used:

1. **Shared stateful services** for databases (see the next section), run as
   single-replica `StatefulSet`s with a stable PVC.
2. **Per-workload PVCs** for anything with its own file state (Grafana's
   SQLite/config volume, Authentik's media and templates, an app's media
   directory, the Hermes Agent data volume).

Because PVCs are namespace-scoped, a workload's storage and its pods always
share a namespace — and a backup job that mounts an app's PVC must therefore run
in the same namespace as that app (see below).

### Backup & recovery

All state is backed up with **restic to Cloudflare R2**. The helper
`createBackupJob` in `iac/maintenance/backup.ts` turns a *source* — a logical
database or a PVC — into a `CronJob` running a restic backup. Each database and
important PVC declares its own backup job in the module that owns it:

- **Databases** are dumped with the app's DB client image and addressed by
  logical database name, so each app's schema is restored independently.
- **PVCs** are tarred read-only from the mounted volume (never written back
  into). Backup jobs default to a daily 03:00 schedule, forbid overlap, and keep
  a bounded history.

For a **fresh cluster**, `scripts/restore-cluster.sh` is the single entry point
that hydrates PVCs and databases from the R2 restic repository. It is destructive
by design — run it once against a clean cluster.

---

## The shared-database pattern

This is the architecture's answer to "many small apps, one small server." Rather
than each app provisioning its own database engine (and its own share of memory,
disk, and admin), apps **share one engine per flavor** and keep their data
**logically isolated**:

- **Shared PostgreSQL** (`shared-resources`) hosts one logical database + a
  dedicated user per app — currently Tandoor, Authentik, Linkwarden, Forgejo,
  LiteLLM, and Outline. It is a single-replica StatefulSet with its own PVC;
  databases and users are declared in the module, and each app connects with its
  own credentials against its own schema, so there is no cross-app access.
- **Shared MariaDB** (`shared-resources`) does the same for the one
  MySQL-flavored app (Grimmory), sized for the small load.

This is why the cluster runs comfortably on modest resources — most apps are
simple, low-traffic services that would each otherwise waste a whole database
engine. The accepted trade-off is that several apps share one engine's
availability, but backups are centralized and regularly exercised.

The shared services live in `iac/shared-resources/shared-postgres.ts` and
`iac/shared-resources/shared-mariadb.ts`. An app opts in by adding its database +
user to the relevant module and pointing at the shared in-cluster host
(`shared-postgres.shared-resources.svc.cluster.local`).

---

## Agent workloads

The cluster hosts an AI-agent fleet, and treats it as security-critical:

- **Hermes Agent** (`agent-sidekicks`) is the assistant that drives messaging,
  cron, and tool integration. It runs under the **`kata-qemu` RuntimeClass**
  (deep isolation even for the assistant itself) and talks to the LLM backend
  through the LiteLLM gateway in `infrastructure` rather than holding provider
  keys for every model. Its dashboard is fronted by Authentik OIDC; its
  OpenAI-compatible API endpoint uses its own bearer key. The component is
  `custom:selfhosted:HermesAgent` in `iac/components/hermes/hermes-agent.ts`.
- **MCP servers** (`agent-sidekicks`) expose read/write tooling to agents for
  Tandoor, Outline, Grafana, and Kubernetes. They live in their own namespace,
  separate from the pods that actually *execute* arbitrary agent code.
- **Sandboxed execution** (`agent-sandbox`, the `agents*` namespaces) runs
  untrusted agent-generated code in **Kata Containers** — a real VM boundary per
  pod, not a container sandbox. Kata is installed entirely through the IaC via
  the `kata-deploy` Helm chart, which injects host runtimes and patches k3s'
  `containerd` to register the RuntimeClass (`iac/infrastructure/index.ts`).

Developers can model further staff and agents through the RBAC + namespace
module (`iac/modules/agents/`), which separates the orchestrator's privileges
from the sandboxed workers that do the actual work.

---

## Development & deployment flow

This is how the cluster actually changes, end to end:

1. **Toolchain:** `mise` provides pulumi + node, and the lifecycle tasks
   (`project-setup`, `preview-deployment`) in `mise.toml`.
2. **Edit:** change `iac/` (usually a single app's module or a shared helper).
   The heavy lifting for a new app is the `SelfhostedApp` component in
   `iac/library/selfhosted-component.ts` — a reusable wrapper that renders the
   Deployment, Service, volumes, ingress, and its database/PVC backups from one
   compact config, so a new workload is declared rather than hand-wired.
3. **Validate:** `tsc --noEmit` for type-safety; then the repo's **CI preview**
   (a Pulumi dry-run on the pull request) proves the diff is safe — it must
   report no unexpected deletions/replacements and converge to zero changes.
   Never `pulumi up` by hand.
4. **Merge:** the pull request is opened in Forgejo; a merge is the deployment
   channel. `master` of `homelab-iac` → applied cluster.

Two things follow from this: the **git repository is the deployment manifest**,
and a new app is on the box once its PR merges and the CI-applied stack catches
up.

---

## Layout of the IaC repo

Everything lives under `iac/`, split by responsibility:

| Path | Contents |
|------|----------|
| `iac/index.ts` | Root program; wires namespaces together in dependency order |
| `iac/shared-resources/` | Shared Postgres + MariaDB, bridge policies |
| `iac/selfhosted/` | User-facing apps, `cloudflared` tunnel, CoreDNS, security baseline, shared labels, shared users |
| `iac/infrastructure/` | Authentik, LiteLLM, Kata deployment, sysctl-tuner |
| `iac/forgejo/` | Forgejo server + Actions runner |
| `iac/agent-sidekicks/` | MCP servers + Hermes Agent |
| `iac/components/hermes/` | Reusable `HermesAgent` component |
| `iac/modules/agents/` | Agent namespaces, RBAC, secrets, cleanup cron |
| `iac/monitoring/` | Prometheus, Loki, Alloy, Grafana, exporters |
| `iac/maintenance/` | Backup jobs + scripts |
| `iac/library/` | Reusable helpers: ingress, PVC, `SelfhostedApp` component, MCP server |
| `scripts/` | Standalone shell helpers (deploy, restore, …) |

The repo also records the few things that still need a human hand
(`docs/manual-configuration.md`) and one-off recovery recipes that aren't part
of the Pulumi graph (`docs/manual-hacks.md`).
