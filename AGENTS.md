# Agent Instructions

## Core Tenets for Infrastructure as Code
* **Priority 1: Zero ClickOps**: Maintain the infrastructure completely automated. Never perform manual steps or "ClickOps". Everything must be automated through code; that is the fundamental point of Infrastructure as Code. While temporary hacks to restart or patch components for the sake of rollbacks are acceptable, you must **always ask for explicit permission** before implementing any hack that would require a manual step to successfully deploy the infrastructure.

## Core Tenets for Code Comments
* **Never state WHAT the code is doing**: The code itself should be readable enough to explain what it does (e.g. creating a deployment, declaring a variable). Avoid redundant comments like `// Create Secret for Django security`.
* **Always explain WHY**: Comments should provide additional context, explain why a particular decision was made, and outline the constraints that were faced.
* **Add Context**: For example, instead of writing `// Redis Deployment`, explain *why* Redis is needed: `// Redis is a hard dependency for authentik. It is used as an internal task queue.`
