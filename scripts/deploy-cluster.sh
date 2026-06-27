#!/bin/bash
set -eo pipefail

# Master Deployment Orchestrator Script for the Homelab Cluster.
# Handles the complete lifecycle including bootstrapping, deployment, and database/volume restoration.

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPTS_DIR")"
cd "$PROJECT_ROOT"

# Ensure context is set to baremetal
CURRENT_CONTEXT=$(kubectl config current-context)
if [ "$CURRENT_CONTEXT" != "baremetal" ]; then
  echo "Switching Kubernetes context to 'baremetal'..."
  kubectl config use-context baremetal
fi

echo "=== Step 1: Enabling Bootstrap Mode ==="
pulumi config set selfhosted:bootstrapMode true --cwd iac --stack local

echo "=== Step 2: Deploying Infrastructure Shell ==="
pulumi up --cwd iac --stack local --yes

echo "=== Step 3: Restoring Data from Backups ==="
./scripts/restore-cluster.sh

echo "=== Step 4: Disabling Bootstrap Mode ==="
pulumi config set selfhosted:bootstrapMode false --cwd iac --stack local

echo "=== Step 5: Finalizing SSO and Provider Configuration ==="
pulumi up --cwd iac --stack local --yes

echo "=== Deployment and Restoration Complete! ==="
