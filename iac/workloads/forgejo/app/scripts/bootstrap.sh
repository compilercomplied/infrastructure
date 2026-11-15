#!/usr/bin/env bash
set -e

# Start the main Forgejo process in the background using the official entrypoint (which launches s6-svscan)
/usr/bin/entrypoint &
pid=$!

# Wait for the HTTP service to start up and finish database migrations
echo "Waiting for Forgejo HTTP port 3000 to be open..."
until wget -qO- http://127.0.0.1:3000/ >/dev/null 2>&1; do
  if ! kill -0 $pid 2>/dev/null; then
    echo "Main process exited prematurely."
    exit 1
  fi
  sleep 2
done
echo "Forgejo is ready. Proceeding with configuration..."

# Forgejo keeps this source in its database, so restarts must reconcile changed
# client credentials as well as scopes.
# We run this as the 'git' user using su-exec to bypass Gitea/Forgejo root checks.
oidc_source_id=$(su-exec git forgejo admin auth list | while IFS= read -r line; do
  if [[ "$line" == *Keycloak* ]]; then
    set -- $line
    printf '%s' "$1"
    break
  fi
done)

if [ -z "$oidc_source_id" ]; then
  echo "Adding Keycloak OIDC authentication source..."
  su-exec git forgejo admin auth add-oauth \
    --name "Keycloak" \
    --provider "openidConnect" \
    --key "$OIDC_CLIENT_ID" \
    --secret "${OIDC_CLIENT_SECRET}" \
    --auto-discover-url "$OIDC_DISCOVERY_URL" \
    --scopes "$OIDC_SCOPES"
else
  echo "Updating Keycloak OIDC source..."
  su-exec git forgejo admin auth update-oauth \
    --id "$oidc_source_id" \
    --provider "openidConnect" \
    --key "$OIDC_CLIENT_ID" \
    --secret "${OIDC_CLIENT_SECRET}" \
    --auto-discover-url "$OIDC_DISCOVERY_URL" \
    --scopes "$OIDC_SCOPES"
fi

# Seed the admin user if not already present (checking word boundaries to handle ID column)
if ! su-exec git forgejo admin user list | grep -q "[[:space:]]dario[[:space:]]"; then
  echo "Creating admin user 'dario'..."
  su-exec git forgejo admin user create \
    --username "dario" \
    --email "${USER_EMAIL}" \
    --random-password \
    --admin
fi

# Register each offline runner with its own pre-shared secret. Forgejo derives a runner UUID
# from the secret, so sharing one would make their daemon declarations overwrite each other.
if [ -n "${RUNNER_SECRET}" ]; then
  echo "Registering offline runner 'k8s-runner'..."
  su-exec git forgejo forgejo-cli actions register \
    --name "k8s-runner" \
    --secret "${RUNNER_SECRET}" \
    --labels "custom-runner,ubuntu-latest,ubuntu-22.04,ubuntu-20.04"
else
  echo "RUNNER_SECRET not set, skipping runner registration."
fi

if [ -n "${ANDROID_RUNNER_SECRET}" ]; then
  echo "Registering offline runner 'android-kvm-runner'..."
  su-exec git forgejo forgejo-cli actions register \
    --name "android-kvm-runner" \
    --secret "${ANDROID_RUNNER_SECRET}" \
    --labels "android-kvm"
else
  echo "ANDROID_RUNNER_SECRET not set, skipping Android runner registration."
fi

# Wait for the background Forgejo web process to keep the container running
wait $pid
