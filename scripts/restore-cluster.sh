#!/bin/bash
set -eo pipefail

# Production-grade Disaster Recovery and Migration Restore Script.
# Automatically extracts credentials from Pulumi and restores all databases
# and PVC volumes from the latest Restic/R2 snapshots into the active K8s context.
#
# Strategy:
#   - Databases: restored via `kubectl exec` directly inside the running StatefulSet pods.
#     This bypasses network policy, pod scheduling, and attach-timing issues entirely.
#   - PVCs: restored via a temporary `kubectl run` pod with the PVC mounted, since PVCs
#     cannot be mounted by running StatefulSet pods while they are in use.

# Ensure the script is run in the root directory
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPTS_DIR")"
cd "$PROJECT_ROOT"

# Core Tenet: Zero ClickOps. Confirm context is set to baremetal to avoid accidents.
CURRENT_CONTEXT=$(kubectl config current-context)
if [ "$CURRENT_CONTEXT" != "baremetal" ]; then
  echo "ERROR: Active Kubernetes context is '$CURRENT_CONTEXT'. This script must only run against the 'baremetal' context."
  echo "Please run: kubectl config use-context baremetal"
  exit 1
fi

echo "Retrieving backup secrets and credentials from Pulumi..."
RESTIC_REPOSITORY=$(pulumi config get maintenance:resticRepository --cwd iac --stack local)
RESTIC_PASSWORD=$(pulumi config get maintenance:resticPassword --cwd iac --stack local)
AWS_ACCESS_KEY_ID=$(pulumi config get maintenance:r2AccessKeyId --cwd iac --stack local)
AWS_SECRET_ACCESS_KEY=$(pulumi config get maintenance:r2SecretAccessKey --cwd iac --stack local)

POSTGRES_ADMIN_PASS=$(pulumi config get selfhosted:postgresPassword --cwd iac --stack local)
TANDOOR_DB_PASS=$(pulumi config get selfhosted:tandoorDbPassword --cwd iac --stack local)
AUTHENTIK_DB_PASS=$(pulumi config get selfhosted:authentikDbPassword --cwd iac --stack local)
LINKWARDEN_DB_PASS=$(pulumi config get selfhosted:linkwardenDbPassword --cwd iac --stack local)
GRIMMORY_DB_PASS=$(pulumi config get selfhosted:grimmoryDbPassword --cwd iac --stack local)
# MariaDB root password is the same as the user password (by design in grimmory.ts).
MARIADB_ROOT_PASS="$GRIMMORY_DB_PASS"

# ==========================================
# 0. SCALE DOWN APPS
# ==========================================
echo "=== Phase 0: Scaling down apps to quiesce DB connections ==="
kubectl scale deployment authentik-server authentik-worker linkwarden tandoor-recipes grimmory -n selfhosted --replicas=0
echo "Waiting 10s for connections to close..."
sleep 10

# ==========================================
# 1. DATABASE RESTORATION PHASE
# ==========================================
echo "=== Phase 1: Restoring Databases ==="

# Restores a PostgreSQL database by exec-ing directly into the shared-postgres StatefulSet pod.
# This avoids all pod scheduling, network policy, and attach-timing complexity.
# The postgres image is Debian-based, so we use apt/wget to bootstrap restic.
restore_postgres_db() {
  local app_name="$1"
  local db_name="$2"
  local db_user="$3"
  local db_pass="$4"

  echo "--- Restoring postgres database: ${db_name} ---"

  kubectl exec -n selfhosted -i shared-postgres-0 -- /bin/bash -c "
    set -e

    # Bootstrap restic from GitHub if not already present.
    if ! command -v restic &>/dev/null; then
      echo 'Installing restic...'
      apt-get update -q && apt-get install -y -q bzip2
      wget -q -O /tmp/restic.bz2 https://github.com/restic/restic/releases/download/v0.16.4/restic_0.16.4_linux_amd64.bz2
      bzip2 -d /tmp/restic.bz2
      chmod +x /tmp/restic && mv /tmp/restic /usr/local/bin/restic
    fi

    export RESTIC_REPOSITORY='${RESTIC_REPOSITORY}'
    export RESTIC_PASSWORD='${RESTIC_PASSWORD}'
    export AWS_ACCESS_KEY_ID='${AWS_ACCESS_KEY_ID}'
    export AWS_SECRET_ACCESS_KEY='${AWS_SECRET_ACCESS_KEY}'
    export AWS_DEFAULT_REGION='us-east-1'

    echo 'Dropping and recreating database ${db_name}...'
    psql -U postgres -c \"DROP DATABASE IF EXISTS ${db_name} WITH (FORCE);\"
    psql -U postgres -c \"CREATE DATABASE ${db_name} OWNER ${db_user};\"

    echo 'Streaming snapshot into ${db_name}...'
    restic dump --tag database,postgres,${app_name} latest ${db_name}.sql | psql -U ${db_user} -d ${db_name}
    echo 'Done: ${db_name}'
  "
}

# Restores a MariaDB database by exec-ing directly into the grimmory-db StatefulSet pod.
restore_mariadb_db() {
  local app_name="$1"
  local db_name="$2"
  local db_user="$3"
  local db_pass="$4"

  echo "--- Restoring mariadb database: ${db_name} ---"

  kubectl exec -n selfhosted -i grimmory-db-0 -- /bin/bash -c "
    set -e

    # Bootstrap restic from GitHub if not already present.
    if ! command -v restic &>/dev/null; then
      echo 'Installing restic...'
      apt-get update -q && apt-get install -y -q bzip2 wget
      wget -q -O /tmp/restic.bz2 https://github.com/restic/restic/releases/download/v0.16.4/restic_0.16.4_linux_amd64.bz2
      bzip2 -d /tmp/restic.bz2
      chmod +x /tmp/restic && mv /tmp/restic /usr/local/bin/restic
    fi

    export RESTIC_REPOSITORY='${RESTIC_REPOSITORY}'
    export RESTIC_PASSWORD='${RESTIC_PASSWORD}'
    export AWS_ACCESS_KEY_ID='${AWS_ACCESS_KEY_ID}'
    export AWS_SECRET_ACCESS_KEY='${AWS_SECRET_ACCESS_KEY}'
    export AWS_DEFAULT_REGION='us-east-1'

    echo 'Dropping and recreating database ${db_name}...'
    # MariaDB 11+ renamed the mysql binary to mariadb.
    MYSQL_PWD='${MARIADB_ROOT_PASS}' mariadb -u root -e \"DROP DATABASE IF EXISTS ${db_name}; CREATE DATABASE ${db_name} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\"

    echo 'Streaming snapshot into ${db_name}...'
    restic dump --tag database,mariadb,${app_name} latest ${db_name}.sql | MYSQL_PWD='${db_pass}' mariadb -u ${db_user} ${db_name}
    echo 'Done: ${db_name}'
  "
}

restore_postgres_db "tandoor-recipes" "tandoor" "tandoor" "$TANDOOR_DB_PASS"
restore_postgres_db "authentik" "authentik" "authentik" "$AUTHENTIK_DB_PASS"
restore_postgres_db "linkwarden" "linkwarden" "linkwarden" "$LINKWARDEN_DB_PASS"
restore_mariadb_db "grimmory" "grimmory" "grimmory" "$GRIMMORY_DB_PASS"

# ==========================================
# 2. PERSISTENT VOLUME RESTORATION PHASE
# ==========================================
echo "=== Phase 2: Restoring PVC Volumes ==="

# PVC volumes require a temporary pod since we cannot mount a PVC that is already
# attached to a running StatefulSet pod. We use the official restic image which is
# Alpine-based and has restic pre-installed, avoiding any bootstrap step.
restore_pvc_volume() {
  local app_name="$1"
  local pvc_name="$2"
  local mount_path="$3"

  echo "--- Restoring PVC: ${pvc_name} ---"

  # Build the overrides JSON with metadata labels included so NetworkPolicy allows egress
  # from the pod. Restic credentials are injected via the spec env block.
  local overrides
  overrides=$(cat <<EOF
{
  "metadata": {"labels": {"network/allow-egress": "true"}},
  "spec": {
    "restartPolicy": "Never",
    "containers": [{
      "name": "restore-pvc",
      "image": "restic/restic:0.16.4",
      "command": ["/bin/sh", "-c", "restic restore --tag pvc,${app_name} --target / latest && echo Done"],
      "env": [
        {"name": "RESTIC_REPOSITORY", "value": "${RESTIC_REPOSITORY}"},
        {"name": "RESTIC_PASSWORD", "value": "${RESTIC_PASSWORD}"},
        {"name": "AWS_ACCESS_KEY_ID", "value": "${AWS_ACCESS_KEY_ID}"},
        {"name": "AWS_SECRET_ACCESS_KEY", "value": "${AWS_SECRET_ACCESS_KEY}"},
        {"name": "AWS_DEFAULT_REGION", "value": "us-east-1"}
      ],
      "volumeMounts": [{"name": "target-volume", "mountPath": "${mount_path}"}]
    }],
    "volumes": [{"name": "target-volume", "persistentVolumeClaim": {"claimName": "${pvc_name}"}}]
  }
}
EOF
)

  kubectl run "restore-pvc-${pvc_name}" \
    --namespace=selfhosted \
    --image="restic/restic:0.16.4" \
    --restart=Never \
    --overrides="$overrides" \
    --attach=true \
    --rm=true
}

restore_pvc_volume "tandoor-recipes" "tandoor-recipes-media-pvc" "/opt/recipes/mediafiles"
restore_pvc_volume "authentik" "authentik-media-pvc" "/media"
restore_pvc_volume "authentik" "authentik-templates-pvc" "/templates"
restore_pvc_volume "linkwarden" "linkwarden-pvc" "/data/data"
restore_pvc_volume "grimmory" "grimmory-books-pvc" "/books"
restore_pvc_volume "grimmory" "grimmory-data-pvc" "/app/data"
restore_pvc_volume "syncthing" "syncthing-data-pvc" "/var/syncthing"
restore_pvc_volume "hermes-agent" "hermes-agent-pvc" "/opt/data"

# ==========================================
# 3. SCALE APPS BACK UP
# ==========================================
echo "=== Phase 3: Scaling apps back up ==="
kubectl scale deployment authentik-server authentik-worker linkwarden tandoor-recipes grimmory -n selfhosted --replicas=1

echo "=== Restoration Completed Successfully ==="
