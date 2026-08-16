#!/usr/bin/env bash
set -euo pipefail

# Script to adjust repository branch protection permissions for the 'home' organization.
# This script runs via kubectl exec to perform operations directly inside the running Forgejo pod.

NAMESPACE="forgejo"
POD_NAME=$(kubectl get pods -n "$NAMESPACE" -l app=forgejo -o jsonpath='{.items[0].metadata.name}')

echo "Executing branch protection adjustment inside Forgejo pod: $POD_NAME..."

kubectl exec -n "$NAMESPACE" "$POD_NAME" -- /bin/bash -c '
  set -e
  TOKEN=$(cat /data/gitea/hermes-token.txt)
  
  # Fetch all repository names under the "home" organization
  REPOS=$(curl -s -H "Authorization: token $TOKEN" http://localhost:3000/api/v1/orgs/home/repos | grep -o '\''"name":"[^"]*"'\'' | cut -d'\'':'\'' -f2 | tr -d '\''"'\'')
  
  for REPO in $REPOS; do
    echo "Processing repository: home/$REPO"
    
    for BRANCH in master main trunk; do
      # Check if branch protection is already configured
      PROTECTIONS=$(curl -s -H "Authorization: token $TOKEN" "http://localhost:3000/api/v1/repos/home/$REPO/branch_protections")
      
      if echo "$PROTECTIONS" | grep -q "\"branch_name\":\"$BRANCH\""; then
        echo "  Branch \"$BRANCH\" is already protected."
      else
        echo "  Creating branch protection rule for \"$BRANCH\"..."
        curl -s -X POST "http://localhost:3000/api/v1/repos/home/$REPO/branch_protections" \
          -H "Authorization: token $TOKEN" \
          -H "Content-Type: application/json" \
          -d "{
            \"branch_name\": \"$BRANCH\",
            \"enable_push\": true,
            \"enable_push_whitelist\": true,
            \"push_whitelist_usernames\": [],
            \"push_whitelist_teams\": [\"Owners\"],
            \"push_whitelist_deploy_keys\": false
          }" > /dev/null
      fi
    done
  done
  echo "All repositories in organization \"home\" have been processed successfully."
'
