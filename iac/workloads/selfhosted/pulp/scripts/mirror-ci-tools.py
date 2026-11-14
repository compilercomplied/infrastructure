import hashlib
import json
import tempfile
import urllib.request
from pathlib import Path

import yaml
from django.db import transaction
from pulp_file.app.models import FileContent, FileDistribution, FilePublication, FileRepository
from pulpcore.plugin.models import Artifact, ContentArtifact


manifest = json.loads(Path("/etc/pulp/runtime/ci-tools.json").read_text())
content = []


def fetch(url):
    request = urllib.request.Request(url, headers={"User-Agent": "homelab-ci-mirror"})
    with urllib.request.urlopen(request, timeout=180) as response:
        return response.read()


def cached(relative_path):
    item = FileContent.objects.filter(relative_path=relative_path).order_by("-pulp_created").first()
    if item:
        linked = ContentArtifact.objects.filter(content=item, artifact__isnull=False).select_related("artifact").first()
        if linked:
            with linked.artifact.file.open("rb") as stream:
                return stream.read()
    return None


def store(relative_path, data, expected=None):
    digest = hashlib.sha256(data).hexdigest()
    if expected is not None and digest != expected:
        raise ValueError(f"SHA256 mismatch for {relative_path}")
    with transaction.atomic():
        artifact = Artifact.objects.filter(sha256=digest).first()
        if artifact is None:
            with tempfile.TemporaryDirectory(dir="/var/lib/pulp/tmp") as directory:
                temporary = Path(directory) / "artifact"
                temporary.write_bytes(data)
                artifact = Artifact.init_and_validate(str(temporary), expected_digests={"sha256": digest})
                artifact.save()
        item, _ = FileContent.objects.get_or_create(relative_path=relative_path, digest=digest)
        ContentArtifact.objects.get_or_create(content=item, relative_path=relative_path, defaults={"artifact": artifact})
    content.append(item.pk)
    print(f"Mirrored {relative_path}", flush=True)


def mirror(relative_path, url, expected):
    item = FileContent.objects.filter(relative_path=relative_path, digest=expected).first()
    if item and ContentArtifact.objects.filter(content=item, artifact__isnull=False).exists():
        content.append(item.pk)
        return
    store(relative_path, fetch(url), expected)


version = manifest["pulumiVersion"]
upstream = f"https://github.com/pulumi/pulumi/releases/download/v{version}/"
checksum_name = f"pulumi-{version}-checksums.txt"
checksums = cached(f"pulumi/{version}/{checksum_name}") or fetch(upstream + checksum_name)
store(f"pulumi/{version}/{checksum_name}", checksums)
digests = dict((name, digest) for digest, name in (line.split() for line in checksums.decode().splitlines() if line.strip()))
for platform in ("linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"):
    filename = f"pulumi-v{version}-{platform}.tar.gz"
    mirror(f"pulumi/{version}/{filename}", upstream + filename, digests[filename])

version = manifest["forgejoVersion"]
for platform, digest in manifest["forgejoAssets"].items():
    filename = f"terraform-provider-forgejo_{version}_{platform}.zip"
    mirror(f"forgejo/{version}/{filename}", f"https://github.com/svalabs/terraform-provider-forgejo/releases/download/v{version}/{filename}", digest)

indexes = {}
for chart in manifest["charts"]:
    name, version, repo = chart["chart"], chart["version"], chart["fetchOpts"]["repo"]
    metadata_path = f"helm/{name}/{version}/index.yaml"
    index = cached(metadata_path)
    if index is None:
        if repo not in indexes:
            indexes[repo] = fetch(f"{repo}/index.yaml")
        index = indexes[repo]
    entry = next(item for item in yaml.load(index, Loader=yaml.CSafeLoader)["entries"][name] if item["version"] == version)
    url = next(url for url in entry["urls"] if url.startswith("https://github.com/"))
    filename = url.rsplit("/", 1)[1]
    mirror(f"helm/{name}/{version}/{filename}", url, entry["digest"])
    store(metadata_path, yaml.safe_dump({"apiVersion": "v1", "entries": {name: [entry]}}).encode())

# Publish only after every archive verifies, retaining older pins for rollbacks and in-flight jobs.
with transaction.atomic():
    repository, _ = FileRepository.objects.get_or_create(name="ci-tools")
    with repository.new_version() as repository_version:
        repository_version.add_content(FileContent.objects.filter(pk__in=content))
    latest = repository.latest_version()
    publication = FilePublication.objects.filter(repository_version=latest, complete=True).first()
    if publication is None:
        # Initialization has no background Task for Publication.create's CreatedResource link.
        # The publication context still validates paths and marks the result complete atomically.
        with FilePublication.objects.create(repository_version=latest, pass_through=True) as publication:
            pass
    FileDistribution.objects.update_or_create(
        name="ci-tools", defaults={"base_path": "ci-tools", "publication": publication}
    )
