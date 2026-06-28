#!/usr/bin/env bash
set -e

# Create custom template directory if not exists, and write the template to hide the password sign-in form.
# We do this before starting the process so Gitea/Forgejo loads it on boot.
mkdir -p /data/gitea/templates/user/auth
cat << 'EOF' > /data/gitea/templates/user/auth/signin_inner.tmpl
<div class="ui container fluid">
	{{template "base/alert" .}}
	<h4 class="ui top attached header center">
		{{ctx.Locale.Tr "auth.oauth_signin_title"}}
	</h4>
	<div class="ui attached segment">
		{{if .OAuth2Providers}}
		<div id="oauth2-login-navigator" class="tw-py-1">
			<div class="tw-flex tw-flex-col tw-justify-center">
				<div id="oauth2-login-navigator-inner" class="tw-flex tw-flex-col tw-flex-wrap tw-items-center tw-gap-2">
					{{range $provider := .OAuth2Providers}}
						<a class="{{$provider.Name}} ui button tw-flex tw-items-center tw-justify-center tw-py-2 tw-w-full oauth-login-link" href="{{AppSubUrl}}/user/oauth2/{{$provider.DisplayName}}">
							{{$provider.IconHTML 28}}
							{{ctx.Locale.Tr "sign_in_with_provider" $provider.DisplayName}}
						</a>
					{{end}}
				</div>
			</div>
		</div>
		{{else}}
		<div class="ui negative message">
			No authentication methods available.
		</div>
		{{end}}
	</div>
</div>
EOF
chown -R git:git /data/gitea/templates

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

# Register the Authentik OIDC source if not already configured
# We run this as the 'git' user using su-exec to bypass Gitea/Forgejo root checks
if ! su-exec git forgejo admin auth list | grep -q "Authentik"; then
  echo "Adding Authentik OIDC authentication source..."
  su-exec git forgejo admin auth add-oauth \
    --name "Authentik" \
    --provider "openidConnect" \
    --key "forgejo-client-id" \
    --secret "${AUTHENTIK_CLIENT_SECRET}" \
    --auto-discover-url "https://auth.gdario.dev/application/o/forgejo/.well-known/openid-configuration" \
    --scopes "openid email profile"
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

# Ensure Gitea API access token exists for the MCP server.
if [ ! -f /data/gitea/hermes-token.txt ]; then
  echo "Generating access token for dario..."
  token=$(su-exec git forgejo admin user generate-access-token --username dario --token-name hermes-mcp --raw)
  echo "$token" > /data/gitea/hermes-token.txt
  chown git:git /data/gitea/hermes-token.txt
fi

# Wait for the background Forgejo web process to keep the container running
wait $pid
