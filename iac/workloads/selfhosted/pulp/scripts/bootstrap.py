import os
from django.contrib.auth import get_user_model
from django.db import transaction
from pulp_maven.app.models import MavenDistribution, MavenRemote, MavenRepository

# Only the declared operator gains admin privileges; other OIDC users retain RBAC defaults.
email = os.environ["PULP_ADMIN_EMAIL"]
user, created = get_user_model().objects.get_or_create(username=email)
user.email = email
user.is_staff = True
user.is_superuser = True
if created:
    user.set_unusable_password()
user.save()

# The runner's shared egress receives 429s from both Maven Central hostnames.
# The Google Cloud mirror serves the same Central artifacts and checksums.
upstreams = {
    "maven-central": "https://maven-central.storage-download.googleapis.com/maven2/",
    "google-maven": "https://dl.google.com/dl/android/maven2/",
    "gradle-plugins": "https://plugins.gradle.org/m2/",
}

with transaction.atomic():
    for name, url in upstreams.items():
        remote, _ = MavenRemote.objects.update_or_create(
            name=f"android-ci-{name}", defaults={"url": url, "policy": "on_demand"}
        )
        repository, _ = MavenRepository.objects.update_or_create(
            name=remote.name, defaults={"remote": remote}
        )
        MavenDistribution.objects.update_or_create(
            name=remote.name,
            defaults={
                "base_path": f"android-ci/{name}",
                "repository": repository,
                "remote": remote,
            },
        )
