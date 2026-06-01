[[__TOC__]]

# Self-hosted Workloads

Infrastructure and deployment documentation for personal, self-hosted services running in the cluster.

## Services

### 1. Shared PostgreSQL
A shared PostgreSQL instance used as the database engine for multiple self-hosted services.
- **Source of Truth**: [shared-postgres.ts](file:///Users/gdario/code/infrastructure/iac/selfhosted/shared-postgres.ts)
- **Engine Version**: `postgres:16-alpine`

#### Database Isolation & Collisions
To prevent table collisions, security vulnerabilities, or permission conflicts between applications, each workload is fully isolated at the PostgreSQL engine level:
1. **Dedicated Database**: Each application has its own separate database.
2. **Dedicated User**: Each application connects using a unique database user account.
3. **PostgreSQL 15+ Permissions**: Since PostgreSQL 15, write (`CREATE`) privileges on the `public` schema are restricted to the database owner by default. To allow applications to run database migrations, the database owner must be set to the application user, and permissions on the `public` schema must be explicitly granted.

#### Adding a New Database
When deploying a new application that uses the shared PostgreSQL instance, add its initialization commands to the startup script inside [shared-postgres.ts](file:///Users/gdario/code/infrastructure/iac/selfhosted/shared-postgres.ts):
```sql
CREATE USER new_app WITH PASSWORD 'secure_password';
CREATE DATABASE new_app OWNER new_app;
GRANT ALL PRIVILEGES ON DATABASE new_app TO new_app;
\c new_app
GRANT ALL ON SCHEMA public TO new_app;
```

---

### 2. Tandoor Recipes
A recipe manager and meal planner application.
- **Source of Truth**: [tandoor-recipes.ts](file:///Users/gdario/code/infrastructure/iac/selfhosted/tandoor-recipes.ts)
- **Port mapping**: The internal container server listens on port `8080` (configured via `TANDOOR_PORT`).

---

## Deployment & Configuration Guidelines

### 1. Tailscale Exposure
Services can be exposed securely on your tailnet using the Tailscale Kubernetes Operator. 
* **Allowed Tags**: The Tailscale Operator is configured with a default tag policy defined in [tailscale.ts](file:///Users/gdario/code/infrastructure/iac/modules/tailscale.ts). Only `tag:kubernetes` is permitted.
* **Service Annotations**: To expose a service, annotate the Kubernetes Service definition:
  ```typescript
  annotations: {
    "tailscale.com/expose": "true",
    "tailscale.com/hostname": "service-name",
    "tailscale.com/tags": "tag:kubernetes",
  }
  ```
  Adding other tags that are not explicitly authorized on the Tailscale OAuth/Operator client will cause a `400` provisioning error.

### 2. Kubernetes Service Environment Variable Conflicts
Kubernetes automatically injects environment variables for all services active in a namespace into all pods running within that same namespace.
* **The Conflict**: If a Service is named exactly the same as an internal application config variable (e.g. `tandoor` Service injecting `TANDOOR_PORT=tcp://<CLUSTER_IP>:<PORT>`), it will collide with the application's configuration (which expects a plain port number like `8080`), crashing the Nginx web server.
* **The Resolution**: Renaming the Service to `tandoor-recipes` prevents the collision because Kubernetes now injects `TANDOOR_RECIPES_PORT` instead. However, to maintain robust and predictable configurations, we still explicitly define `TANDOOR_PORT` under the container `env` specification in [tandoor-recipes.ts](file:///Users/gdario/code/infrastructure/iac/selfhosted/tandoor-recipes.ts):
  ```typescript
  env: [
    { name: "TANDOOR_PORT", value: "8080" },
  ]
  ```
