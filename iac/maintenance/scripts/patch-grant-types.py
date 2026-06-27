import os
import django

# Set up the Authentik Django environment
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "authentik.root.settings")
django.setup()

from authentik.providers.oauth2.models import OAuth2Provider
from authentik.stages.identification.models import IdentificationStage
from authentik.sources.oauth.models import OAuthSource

expected_grant_types = ["authorization_code", "refresh_token"]

# 1. Iterate over all registered OAuth2 providers and patch them if grant types are empty/incorrect
for provider in OAuth2Provider.objects.all():
    if set(provider.grant_types) != set(expected_grant_types):
        provider.grant_types = expected_grant_types
        provider.save()
        print(f"Successfully patched grant types for provider: {provider.name}")

# 2. Disable public self-service registration (clear enrollment flow from default identification stage)
try:
    auth_stage = IdentificationStage.objects.get(name="default-authentication-identification")
    if auth_stage.enrollment_flow is not None:
        auth_stage.enrollment_flow = None
        auth_stage.save()
        print("Successfully disabled public self-service registration.")
except IdentificationStage.DoesNotExist:
    print("Warning: default-authentication-identification stage not found.")

# 3. Configure Google OIDC login stage and disable self-service Google signup
try:
    auth_stage = IdentificationStage.objects.get(name="default-authentication-identification")
    google_source = OAuthSource.objects.get(slug="google")
    
    # Ensure the Google SSO button is displayed on the login page
    if google_source not in auth_stage.sources.all():
        auth_stage.sources.add(google_source)
        auth_stage.save()
        print("Successfully added Google SSO to default login page sources.")

    # Ensure self-service registration via Google is disabled (must match pre-created email profile)
    if google_source.enrollment_flow is not None:
        google_source.enrollment_flow = None
        google_source.save()
        print("Successfully disabled Google self-service signup (cleared source enrollment flow).")
except (IdentificationStage.DoesNotExist, OAuthSource.DoesNotExist) as e:
    print(f"Warning: Could not configure Google OIDC login stage/source due to: {e}")

