#!/bin/sh
set -e

# Grimmory stores its OIDC details in the database 'app_settings' table. Saving settings in the
# admin web UI strips/clears the clientSecret field (due to form omission or browser autofill),
# causing token exchange failures. Additionally, the admin UI disables toggle controls for
# 'oidc_force_only_mode' to protect users from locking themselves out, requiring a database patch
# to safely enforce OIDC-only logins.
# Wait for database connectivity to handle slow pod startup and CNI NetworkPolicy programming delay.
echo "Waiting for database connectivity to $DB_HOST..."
export MYSQL_PWD="$DB_PASSWORD"
for i in $(seq 1 30); do
  if mariadb -h "$DB_HOST" -u "$DB_USER" -e "SELECT 1;" >/dev/null 2>&1; then
    echo "Database connectivity established."
    break
  fi
  echo "Database not ready yet, retrying in 2 seconds... (attempt $i/30)"
  sleep 2
done

mariadb -h "$DB_HOST" -u "$DB_USER" -e "
  UPDATE grimmory.app_settings
  SET val = '{\"providerName\":\"Authentik\",\"clientId\":\"grimmory-client-id\",\"clientSecret\":\"$OIDC_CLIENT_SECRET\",\"issuerUri\":\"https://auth.gdario.dev/application/o/grimmory/\",\"scopes\":\"\",\"claimMapping\":{\"email\":\"email\",\"groups\":\"\",\"name\":\"given_name\",\"username\":\"preferred_username\"}}'
  WHERE name = 'oidc_provider_details';
  UPDATE grimmory.app_settings
  SET val = 'true'
  WHERE name = 'oidc_force_only_mode';
"
