[[__TOC__]]

# Agentic workflows
## Features

Custom agentic workflows with a sandboxed coding environment connected to my
personal git repositories.

## Core components

- [discord-agent-bridge](https://github.com/compilercomplied/discord-agent-bridge). Discord bot used to send tasks and prompts to the llm engine.
- [agent-hub](https://github.com/compilercomplied/agent-hub). Integrates with
	third party llm APIs using ReACT pattern to enable complex workflows.
- [agent-dev-environment](https://github.com/compilercomplied/agent-dev-environment). Sandboxed coding environment for secure and isolated coding workflows.

## Hermes Agent Workload

The self-hosted [Hermes Agent](file:///Users/gdario/code/infrastructure/iac/selfhosted/hermes-agent.ts) handles messaging gateway integrations, cron scheduling, and personal assistant tasks. It is configured to ensure user configurations are persistent and protected.

### Configuration & First-Boot Seeding
To allow dynamic configuration edits via the Hermes UI (e.g., enabling/disabling skills or changing settings) without getting overwritten by Pulumi deployments:
- **Seed Template:** The default template is defined in [hermes-config.yaml](file:///Users/gdario/code/infrastructure/iac/selfhosted/templates/hermes-config.yaml).
- **First-Boot Guard:** On startup, the [sync-config.py](file:///Users/gdario/code/infrastructure/iac/maintenance/scripts/sync-config.py) script in the `initContainer` checks if `/opt/data/config.yaml` exists. If it does not, it initializes it from the template. On subsequent deployments, it skips copying to protect active configuration changes.
- **Manual Template Refresh:** If you modify the default configuration template and want to force the running server to re-seed:
  ```bash
  kubectl exec -n selfhosted deployment/hermes-agent -c hermes-agent -- rm /opt/data/config.yaml
  kubectl rollout restart -n selfhosted deployment/hermes-agent
  ```

### PVC Backup
The entire `/opt/data` Persistent Volume (containing configuration, databases, memories, and custom skills) is backed up daily using the automated `hermes-agent-pvc-hermes-agent-pvc` CronJob.
