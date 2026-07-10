# Agent Instructions

## Core Tenets for Infrastructure as Code
* **Priority 1: Zero ClickOps**: Maintain the infrastructure completely automated. Never perform manual steps or "ClickOps". Everything must be automated through code; that is the fundamental point of Infrastructure as Code. While temporary hacks to restart or patch components for the sake of rollbacks are acceptable, you must **always ask for explicit permission** before implementing any hack that would require a manual step to successfully deploy the infrastructure.

## Core Tenets for Code Comments
* **Never state WHAT the code is doing**: The code itself should be readable enough to explain what it does (e.g. creating a deployment, declaring a variable). Avoid redundant comments like `// Create Secret for Django security`.
* **Always explain WHY**: Comments should provide additional context, explain why a particular decision was made, and outline the constraints that were faced.
* **Add Context**: For example, instead of writing `// Redis Deployment`, explain *why* Redis is needed: `// Redis is a hard dependency for authentik. It is used as an internal task queue.`

## Core Tenets for Component Ownership
* **Component-Owned Tooling (Single Source of Truth)**: A component module must own the definition of the client tooling, versioning, and container images required to interact with it. Downstream components (such as backup jobs or monitoring sidecars) must not hardcode their own client versions or install scripts. Instead, they must import exported configurations or image references from the target component.
  * *Example*: Instead of having the backup module install `postgresql-client` dynamically or hardcode a client version, the PostgreSQL module (e.g., [shared-postgres.ts](file:///Users/gdario/code/infrastructure/iac/selfhosted/shared-postgres.ts)) must export a version-matched client image reference (e.g., `export const postgresClientImage = "postgres:16-alpine"`), which the backup module then imports and runs in its CronJob container.

## Core Tenets for Script Management
* **Never hardcode scripts longer than 2 lines**: Do not write inline script strings (e.g., command shell interpolations) longer than 2 lines inside the Pulumi/IaC code. Instead, extract them into their own standalone, parameterized files (e.g., under `iac/maintenance/scripts/`), read them dynamically, and reference them in the code (e.g., using a Kubernetes `ConfigMap` mounted as a script volume). This keeps the infrastructure code readable and makes the scripts easier to lint, update, and test.
