#!/usr/bin/env bash
set -e

# Wait for the Forgejo service HTTP port to be available before trying to create the runner file.
echo "Waiting for Forgejo HTTP endpoint..."
until wget -qO- http://forgejo.selfhosted.svc.cluster.local:80/ >/dev/null 2>&1; do
  sleep 2
done

# Initialize the runner credentials if they don't exist yet.
# We do this in a persistent volume so that the registration is preserved across pod restarts.
if [ ! -f /data/.runner ]; then
  echo "Registering runner with Forgejo using the pre-shared secret..."
  forgejo-runner create-runner-file \
    --instance "http://forgejo.selfhosted.svc.cluster.local:80" \
    --secret "${RUNNER_SECRET}"
fi

# Wait for the Docker daemon to be fully ready before starting the runner daemon.
echo "Waiting for Docker daemon to be ready..."
until wget -qO- http://localhost:2375/_ping >/dev/null 2>&1; do
  sleep 1
done
echo "Docker daemon is ready!"

echo "Starting Forgejo runner daemon..."
exec forgejo-runner daemon --config /config/config.yaml
