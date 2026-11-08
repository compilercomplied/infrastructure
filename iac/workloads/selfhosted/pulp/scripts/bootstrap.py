import os
from django.contrib.auth import get_user_model

# Only the declared operator gains admin privileges; other OIDC users retain RBAC defaults.
email = os.environ["PULP_ADMIN_EMAIL"]
user, created = get_user_model().objects.get_or_create(username=email)
user.email = email
user.is_staff = True
user.is_superuser = True
if created:
    user.set_unusable_password()
user.save()
