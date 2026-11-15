# Agent instructions

For PR reviews, read [docs/agentic-review.md](docs/agentic-review.md).

## Workflow and architecture

- Prefer mise commands.
- Never run `pulumi up`; only preview. PR CI is the source of truth unless pairing with a human.
- Zero ClickOps: manage infrastructure through code. Temporary manual restarts or patches require explicit permission.
- Enforce `default-deny-ingress` across namespaces; allow required ingress with explicit NetworkPolicies.

## Images

- Use explicit release tags verified against the upstream registry; avoid digest pins.
- Replace existing digest pins only with verified exact release provenance. Report unresolved pins; do not guess tags or upgrade unrelated apps.
- Keep Renovate digest pinning and digest updates disabled.

## Documentation and comments

- Code is the source of truth for behavior, configuration, endpoints, and deployment mechanics.
- Document only why: decisions, tradeoffs, external constraints, and recovery rationale the code cannot explain. Link to implementation; do not repeat its behavior.
- Comments explain why, never restate what the code does.
- Delete obsolete migration and rollout notes; Git and PR history preserve them.

## Validation

- Do not add manual test scripts or tests against mocked objects, APIs, or commands.
- Prefer type checking, syntax checks, and validation of real configuration or Pulumi previews. Any added tests must run automatically against real implementations.
