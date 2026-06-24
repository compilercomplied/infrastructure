# Security Audit: cluster.gdario.dev

> **Scope**: Static code review of the Pulumi IaC, cross-referenced with live cluster inspection via SSH.
> **Question answered**: If Tandoor is compromised, can an attacker reach Syncthing data?

---

## Summary

The cluster is well-structured with a clear security posture: all public apps go through Traefik + TLS, secrets are stored in Kubernetes Secrets (not in code), and OIDC via Authentik is the standard auth layer. However, there are **3 real exposure risks**, **5 medium hardening gaps**, and **14 architectural, workload, supply-chain, or database security gaps** worth addressing.

---

## 🔴 High — Real Exposure Risks

### 1. `ALLOWED_HOSTS = "*"` in Tandoor (RESOLVED)

**File**: [tandoor-recipes.ts](file:///Users/gdario/code/infrastructure/iac/selfhosted/tandoor-recipes.ts#L49)

**Status**: ✅ **Resolved** (Restricted to public domain and internal cluster domains).

```diff
- { name: "ALLOWED_HOSTS", value: "*" },
+ { name: "ALLOWED_HOSTS", value: "recipes.gdario.dev,tandoor-recipes,tandoor-recipes.selfhosted.svc.cluster.local" },
```

Django's `ALLOWED_HOSTS = *` disables the `Host` header check. This is a known vector for [HTTP Host header attacks](https://docs.djangoproject.com/en/5.0/topics/security/#host-headers-virtual-hosting). An attacker who can send a crafted `Host` header to the Tandoor pod (e.g., via SSRF from another compromised pod) can cause Django to trust a malicious host, enabling password-reset link poisoning and open redirect attacks.

**Fix**: Set it to the actual hostnames used by clients.

---

### 2. `skipPathRegex` bypasses Authentik auth on Syncthing REST API

**File**: [authentik-resources.ts](file:///Users/gdario/code/infrastructure/iac/selfhosted/authentik-resources.ts#L126)

```typescript
skipPathRegex: "^/rest/.*",
```

This tells the Authentik proxy to skip authentication for **all** Syncthing REST API calls (`/rest/*`). The intent is presumably to allow Syncthing clients to connect directly (devices/phones). But the Syncthing REST API at `/rest/` gives **full read/write access** to Syncthing config, folder paths, device lists, and can even execute rescan/delete operations. A compromised pod in the same namespace (e.g., Tandoor) could call `http://syncthing.selfhosted.svc.cluster.local/rest/...` over the cluster network and bypass this Authentik layer entirely — because ForwardAuth only protects the ingress, not the pod-to-pod path.

**Verdict**: The `/rest/` bypass is not the primary concern (see Network Policy finding below), but combined with the absence of network policies, this is a real risk. Even if you add network policies, reconsider whether this skip is needed — Syncthing's GUI auth should cover it.

---

### 3. No Network Policies — Zero Lateral Movement Isolation

**Namespace**: `selfhosted`

There are **no `NetworkPolicy` resources defined anywhere in this repo**. This means every pod in the `selfhosted` namespace can reach every other pod on any port. The isolation model is purely perimeter-based (ingress).

**Threat scenario** (what you asked about):
> If Tandoor is compromised → can the attacker access Syncthing data?

**Answer: Yes.** Without NetworkPolicies:
- A compromised Tandoor pod can directly call `http://syncthing.selfhosted.svc.cluster.local:8384` — Syncthing's GUI/API.
- It can also call `http://shared-postgres.selfhosted.svc.cluster.local:5432` directly, and try to authenticate using the Tandoor credentials it already has in its own env.
- Authentik ForwardAuth is an **ingress-layer** control only. Pod-to-pod traffic bypasses it completely.

---

## 🟡 Medium — Hardening Opportunities

### 4. `HERMES_DASHBOARD_OIDC_CLIENT_SECRET` set as plain env var

**File**: [hermes-agent.ts](file:///Users/gdario/code/infrastructure/iac/components/hermes/hermes-agent.ts#L159)

```typescript
{ name: "HERMES_DASHBOARD_OIDC_CLIENT_SECRET", value: hermesSecret },
```

The `hermesSecret` value is passed as a plain `value:` in the env var, not via `secretKeyRef`. While `hermesSecret` is a Pulumi secret (so it's encrypted in state), it will appear in **cleartext** in the pod's environment as seen by `kubectl describe pod`. The secret is already in the K8s `hermes-agent-secrets` object — it should be referenced from there instead.

**Fix**: Reference it via `valueFrom.secretKeyRef` instead.

---

### 5. `API_SERVER_CORS_ORIGINS = "*"` on the Hermes API

**File**: [hermes-agent.ts](file:///Users/gdario/code/infrastructure/iac/components/hermes/hermes-agent.ts#L162)

```typescript
{ name: "API_SERVER_CORS_ORIGINS", value: "*" },
```

The API server is exposed publicly at `hermes-api.gdario.dev` with a wildcard CORS policy. This means any website can make cross-origin requests to the Hermes API. Since the API is protected by an `API_SERVER_KEY` bearer token, the practical risk is limited to credential theft in browser context — but it's not best practice. Restrict to your actual client origins.

---

### 6. `grafana-mcp` and `filesystem-mcp` use `latest` image tags

**Files**: [grafana-mcp.ts](file:///Users/gdario/code/infrastructure/iac/selfhosted/grafana-mcp.ts#L49), [filesystem-mcp.ts](file:///Users/gdario/code/infrastructure/iac/selfhosted/filesystem-mcp.ts#L16)

```typescript
image: "grafana/mcp-grafana:latest",
image: "mcp/filesystem:latest",
```

`latest` tags are mutable — a supply-chain compromise could silently replace the image. Pin to specific digests or at minimum version tags.

---

### 7. `filesystem-mcp` mounts Syncthing's PVC with a SubPath — good, but no `readOnly`

**File**: [filesystem-mcp.ts](file:///Users/gdario/code/infrastructure/iac/selfhosted/filesystem-mcp.ts#L42-L49)

The `subPath: "obsidian-vaults"` is a good scoping choice. However, the mount is read-write. If the `filesystem-mcp` server or the Hermes agent that consumes it were compromised, an attacker could write arbitrary data into your Obsidian vaults. If the MCP server only needs to read files, add `readOnly: true` to the mount.

---

### 8. Authentik Redis has no authentication

**File**: [authentik.ts](file:///Users/gdario/code/infrastructure/iac/selfhosted/authentik.ts#L61-L68)

Redis is deployed without a password and without `--requirepass`. Any pod in the `selfhosted` namespace can connect to `authentik-redis:6379` and read/write to Authentik's session store and task queue. Combined with the lack of NetworkPolicies (Finding 3), a compromised Tandoor pod could potentially forge Authentik sessions.

**Fix**: Add a `requirepass` to Redis and configure Authentik's `AUTHENTIK_REDIS__PASSWORD`.

---

## 🟠 Architecture & Workload Gaps (Second Swipe)

### 9. Automounted Kubernetes API Tokens

**Files**: All deployments (including `selfhosted-app.ts` helper).

By default, Kubernetes mounts the `default` ServiceAccount token into every pod at `/var/run/secrets/kubernetes.io/serviceaccount/token`. If a pod (like Tandoor) is compromised, the attacker can use this token to probe the Kubernetes API. Even if the default service account has no specific permissions, it provides an unnecessary attack surface.

**Fix**: Add `automountServiceAccountToken: false` to all Pod specs.

---

### 10. Missing Pod Security Contexts

**Files**: `selfhosted-app.ts` and all manual Deployments/StatefulSets.

The current IaC does not enforce any `securityContext` restrictions. This means containers run as root, have a writable root filesystem, and retain default Linux capabilities (e.g. `CAP_NET_RAW` which can be used for sniffing or ARP spoofing).

**Fix**: Update `createSelfhostedApp` and workload specs to include `runAsNonRoot: true`, `readOnlyRootFilesystem: true`, and drop all capabilities.

---

### 11. No Resource Limits (CPU/Memory)

**Files**: All deployments.

No workloads define resource `requests` or `limits`. If an attacker compromises a pod, they can run a cryptominer or a fork-bomb to consume all CPU and memory on the node, causing a cluster-wide Denial of Service (DoS).

**Fix**: Define baseline `resources.requests` and `resources.limits` for every container.

---

### 12. Shared Database Isolation

**File**: `shared-postgres.ts`

Tandoor, Authentik, and Linkwarden all share the exact same PostgreSQL database instance. While they use different database users, a local privilege escalation vulnerability within PostgreSQL could allow a compromised Tandoor instance to read the Authentik database (which holds SSO credentials).

**Fix**: Consider separating critical databases (Authentik) from standard apps (Tandoor).

---

## 🟣 Advanced, Supply-Chain & Operational Risks (Third Swipe)

### 13. Dynamic Package Installation at Runtime in Backups

**Files**: [backup-postgres.sh](file:///Users/gdario/code/infrastructure/iac/maintenance/scripts/backup-postgres.sh#L7) and [backup-pvc.sh](file:///Users/gdario/code/infrastructure/iac/maintenance/scripts/backup-pvc.sh#L7)

Both backup scripts dynamically install `restic` at runtime using `apk add --no-cache restic` inside standard containers (`postgres:16-alpine` or `alpine:3.19`). This introduces significant issues:
1.  **Internet/Egress dependency**: If outbound access is locked down (e.g., via Egress NetworkPolicies to prevent data exfiltration), the backup jobs will immediately fail.
2.  **Supply-chain risk**: The backup job downloads whatever version of `restic` is latest in alpine repository mirrors at the moment of run, exposing the process to potential mirror hijacking.
3.  **Reliability**: Backups will fail if Alpine mirrors are down or experience network issues.

**Fix**: Pre-build a dedicated Docker backup image that already contains `restic` and database clients, or pin an official image that has `restic` pre-packaged.

---

### 14. Grimmory Database Hot Backup Risk (Unsafe PVC Backup of Active DB)

**File**: [grimmory.ts](file:///Users/gdario/code/infrastructure/iac/selfhosted/grimmory.ts#L200)

Grimmory's MariaDB database backup is configured as a raw `pvc` file backup of `/var/lib/mysql` while the database container is online. Copying active database files on the fly can result in inconsistent data states (corruption) inside the backup snapshots, making recovery impossible. This is in contrast to the PostgreSQL backups which safely execute `pg_dump`.

**Fix**: Modify Grimmory's backup configuration to use `mariadb-dump` or `mysqldump` to stream consistent sql dumps to restic.

---

### 15. Password Leaked in Process List via CLI Argument

**File**: [patch-grimmory-db.sh](file:///Users/gdario/code/infrastructure/iac/maintenance/scripts/patch-grimmory-db.sh#L9)

The database patch script passes the MariaDB root password using the `-p"$DB_PASSWORD"` command-line argument. In Linux systems, command-line arguments are visible in plaintext to all users and processes on the node (e.g., by running `ps aux` or reading `/proc`). Any compromised pod or local process can read this password.

**Fix**: Pass the password via the `MYSQL_PWD` environment variable instead: `MYSQL_PWD="$DB_PASSWORD" mariadb -h "$DB_HOST" ...`

---

### 16. Dynamic NPM Package Execution via `npx -y` at Container Startup

**File**: [filesystem-mcp.ts](file:///Users/gdario/code/infrastructure/iac/selfhosted/filesystem-mcp.ts#L20-L28)

The `filesystem-mcp` server executes `npx -y supergateway` at container start to wrap the stdio-only server into SSE. This fetches and runs `supergateway` from `npmjs.com` dynamically on every pod startup, introducing network registry dependencies, supply-chain vulnerabilities (lack of package checksum/version pinning), and boot failures if outbound access is blocked.

**Fix**: Pre-install `supergateway` in a custom image or use a pinned NodeJS container image containing the tool.

---

### 17. Security Risk of the `pvc-exporter` DaemonSet (HostPath Escape & Data Leak Vector)

**File**: [pvc-exporter.ts](file:///Users/gdario/code/infrastructure/iac/monitoring/pvc-exporter.ts#L69-L74)

The `pvc-exporter` runs as a DaemonSet mounting the host's `/var/lib/rancher/k3s/storage` directory. Because the pod runs as root and mounts the entire cluster's storage root, if this exporter is compromised, an attacker gains read access to all persistent volume data in the cluster (including Authentik hashes, Tandoor images, and Syncthing vaults). This DaemonSet is also redundant as Kubernetes natively tracks and exposes PVC capacity metrics through Kubelet statistics.

**Fix**: Remove the custom `pvc-exporter` and scrape storage metrics natively from the Kubelet or `kube-state-metrics`.

---

### 18. Loki Log Database Exposed Without Authentication

**File**: [loki.ts](file:///Users/gdario/code/infrastructure/iac/monitoring/loki.ts#L22)

Loki is deployed with `auth_enabled: false`. Since Loki is exposed inside the cluster network as a ClusterIP service, any pod in the cluster (if compromised) can query `http://loki:3100` to retrieve all historical cluster logs. These logs often contain sensitive data, including system audits, stack traces, and accidental secret dumps.

**Fix**: Enable authentication in Loki and configure Grafana/Alloy to use authentication headers, or restrict Loki ingress to authorized scraping pods via NetworkPolicies.

---

### 19. Unrestricted Public LoadBalancer for Syncthing Sync Ports

**File**: [syncthing.ts](file:///Users/gdario/code/infrastructure/iac/selfhosted/syncthing.ts#L83)

Syncthing exposes its sync ports (22000 TCP/UDP) publicly using a `LoadBalancer` service without any firewall/IP restrictions (`loadBalancerSourceRanges`). Since the cluster has Tailscale integration, exposing these sync ports publicly is an unnecessary attack surface (e.g. exposing the Go TLS stack to external scans/exploits).

**Fix**: Restrict the service to trusted IP ranges or route Syncthing sync traffic through the Tailscale VPN.

---

### 20. Lack of Encryption (SSL/TLS) for Internal PostgreSQL Traffic

**Files**: [shared-postgres.ts](file:///Users/gdario/code/infrastructure/iac/selfhosted/shared-postgres.ts), [tandoor-recipes.ts](file:///Users/gdario/code/infrastructure/iac/selfhosted/tandoor-recipes.ts), [linkwarden.ts](file:///Users/gdario/code/infrastructure/iac/selfhosted/linkwarden.ts)

The database does not enforce SSL/TLS, and client configurations (e.g., Tandoor, Linkwarden, Authentik) connect using unencrypted TCP. If an attacker gains network capabilities in the shared namespace (or escapes container boundaries), they can sniff sensitive database queries and credentials (like Authentik user hashes).

**Fix**: Enable SSL in `shared-postgres` and enforce `sslmode=require` on client connections.

---

### 21. No Namespace-level Pod Security Standards (PSA)

**Files**: [namespaces.ts](file:///Users/gdario/code/infrastructure/iac/modules/agents/namespaces.ts), [selfhosted/index.ts](file:///Users/gdario/code/infrastructure/iac/selfhosted/index.ts), [monitoring/index.ts](file:///Users/gdario/code/infrastructure/iac/monitoring/index.ts)

Namespaces do not declare Pod Security Admission (PSA) labels. This allows pods to run with dangerous settings (like hostPID, privileged containers, or hostPath mounts) by default.

**Fix**: Apply the standard Kubernetes labels to enforce `restricted` or `baseline` security profiles on all namespaces: `pod-security.kubernetes.io/enforce: restricted`.

---

### 22. MCP Server HTTP Body Logging (Credentials/Data Leak)

**File**: [tandoor-mcp.ts](file:///Users/gdario/code/infrastructure/iac/selfhosted/tandoor-mcp.ts#L38)

The `tandoor-mcp` server has `LOG_HTTP_BODY: "true"` enabled. This writes all HTTP request and response payloads to standard output. If logs contain user PII, API tokens, or recipe content, they will be scraped and stored in Loki unencrypted, violating data security best practices.

**Fix**: Disable HTTP body logging in production environments.

---

## 🟢 What's Correctly Secured

- ✅ **All secrets via Pulumi encrypted state** — no secrets hardcoded in the repo
- ✅ **TLS everywhere** — cert-manager + Let's Encrypt on all public ingresses
- ✅ **Authentik ForwardAuth on Syncthing's ingress** — correctly blocks unauthenticated web access
- ✅ **Tandoor login form hidden** (`HIDE_LOGIN_FORM=1`) + Linkwarden credentials disabled — SSO-only
- ✅ **Syncthing GUI credentials disabled** (per code comments), enforced centrally via Authentik
- ✅ **Postgres not exposed publicly** — ClusterIP only, no LoadBalancer or NodePort
- ✅ **MCP servers are ClusterIP only** — no ingress, no public route
- ✅ **Google OAuth enrollment flow disabled** — prevents self-service signup
- ✅ **Rate limiting on all public ingresses** — default 360 req/min average, 720 burst

---

## Recommended Fixes (Priority Order)

### P1: Add NetworkPolicies for namespace isolation
This is the most impactful fix. A default-deny policy with allow-lists breaks lateral movement between apps.

### P2: Fix `ALLOWED_HOSTS` in Tandoor
One-line change in [tandoor-recipes.ts](file:///Users/gdario/code/infrastructure/iac/selfhosted/tandoor-recipes.ts#L49).

### P3: Stop hostPath escape in `pvc-exporter` DaemonSet
Remove `pvc-exporter` entirely and scrape native PVC metrics from Kubelet or `kube-state-metrics`.

### P4: Avoid dynamic `npx` execution at startup
Package `supergateway` in a custom image for `filesystem-mcp`.

### P5: Avoid dynamic `apk add` inside backup CronJobs
Use backup container images that already have `restic` pre-installed to prevent internet dependencies.

### P6: Unsafe database hot backups
Use database dump utilities (`mariadb-dump` / `mysqldump`) for Grimmory instead of copying active PVC data files.

### P7: Secure DB password in patch scripts
Use `MYSQL_PWD` inside `patch-grimmory-db.sh` instead of the `-p` CLI argument.

### P8: Enable PostgreSQL SSL/TLS
Enforce TLS/SSL connections between the database and clients (Authentik, Tandoor, Linkwarden).

### P9: Add Redis authentication for Authentik
Add `--requirepass` to the Redis args in [authentik.ts](file:///Users/gdario/code/infrastructure/iac/selfhosted/authentik.ts) and set `AUTHENTIK_REDIS__PASSWORD`.

### P10: Fix Hermes OIDC secret to use `secretKeyRef`
One-line change in [hermes-agent.ts](file:///Users/gdario/code/infrastructure/iac/components/hermes/hermes-agent.ts#L159).

### P11: Add `readOnly: true` to `filesystem-mcp` volume mount
One-line change in [filesystem-mcp.ts](file:///Users/gdario/code/infrastructure/iac/selfhosted/filesystem-mcp.ts).

### P12: Pin `latest` image tags
Pin `grafana/mcp-grafana` and `mcp/filesystem` to specific versions.

### P13: Disable Service Account Automounting & Enforce PSA
Set `automountServiceAccountToken: false` on all pods, and add Pod Security Admission labels to namespaces.

### P14: Workload Hardening (Security Contexts & Limits)
Enforce non-root execution, read-only root filesystems, drop capabilities, and set resource limits.

---

## Tandoor → Syncthing Attack Path (Full Analysis)

To directly answer your question:

| Step | Current State | After NetworkPolicies |
|------|--------------|----------------------|
| Tandoor pod exec → `curl syncthing:8384/rest/system/ping` | ✅ **Works** (no network policy) | ❌ Blocked |
| Tandoor pod → `psql shared-postgres` with tandoor creds | ✅ **Works** (no network policy, same DB) | ❌ Blocked |
| Tandoor pod → `redis-cli -h authentik-redis` | ✅ **Works** | ❌ Blocked |
| Web browser → `https://syncthing.gdario.dev` unauthenticated | ❌ Blocked by Authentik ForwardAuth | ❌ Blocked |
| Web browser → `https://recipes.gdario.dev` unauthenticated | ❌ Blocked (no login form, SSO redirect) | ❌ Blocked |

The perimeter is solid. The **interior** (east-west traffic) is the gap.
