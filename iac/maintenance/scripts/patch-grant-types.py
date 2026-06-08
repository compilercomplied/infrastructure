import os
import django

# Set up the Authentik Django environment
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "authentik.root.settings")
django.setup()

from authentik.providers.oauth2.models import OAuth2Provider

expected_grant_types = ["authorization_code", "refresh_token"]

# Iterate over all registered OAuth2 providers and patch them if grant types are empty/incorrect
for provider in OAuth2Provider.objects.all():
    if set(provider.grant_types) != set(expected_grant_types):
        provider.grant_types = expected_grant_types
        provider.save()
        print(f"Successfully patched grant types for provider: {provider.name}")
