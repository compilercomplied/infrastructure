#!/bin/sh
set -e

# Grimmory stores its OIDC details in the database 'app_settings' table. Saving settings in the
# admin web UI strips/clears the clientSecret field (due to form omission or browser autofill),
# causing token exchange failures. Additionally, the admin UI disables toggle controls for
# 'oidc_force_only_mode' to protect users from locking themselves out, requiring a database patch
# to safely enforce OIDC-only logins.
mariadb -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASSWORD" -e "
  UPDATE grimmory.app_settings
  SET val = '{\"providerName\":\"Authentik\",\"clientId\":\"grimmory-client-id\",\"clientSecret\":\"$OIDC_CLIENT_SECRET\",\"issuerUri\":\"https://auth.gdario.dev/application/o/grimmory/\",\"scopes\":\"\",\"claimMapping\":{\"email\":\"email\",\"groups\":\"\",\"name\":\"given_name\",\"username\":\"preferred_username\"}}'
  WHERE name = 'oidc_provider_details';
  UPDATE grimmory.app_settings
  SET val = 'true'
  WHERE name = 'oidc_force_only_mode';
"
