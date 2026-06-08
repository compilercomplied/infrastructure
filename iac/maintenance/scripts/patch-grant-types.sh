#!/bin/sh
set -e

# Patches OIDC provider grant types in Authentik.
# This script is required because the Pulumi Authentik SDK is an older version and
# does not expose the grant_types attribute, while Authentik 2026+ defaults them to empty.

TOKEN="$1"
shift

for id in "$@"; do
  echo "Patching provider ID: $id..."
  curl -X PATCH -s -f \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"grant_types": ["authorization_code", "refresh_token"]}' \
    "https://auth.gdario.dev/api/v3/providers/oauth2/$id/"
done
