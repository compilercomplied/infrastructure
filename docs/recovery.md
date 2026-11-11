# Recovery limitations

**The legacy [restore script](../scripts/restore-cluster.sh) is not a current
cluster recovery procedure.** It still targets the former all-in-`selfhosted`
layout and old database names, while workloads now span multiple namespaces.
It also restores a fixed subset of applications. Update and review its targets,
coverage, and snapshot selection before an authorized restore; do not run it
against the current cluster on the strength of the old migration instructions.

The script drops databases, replaces volume contents, and changes workload
replicas. Repeating it can destroy writes made since the previous restore.
Quiesce writers before restoring so live connections or in-memory state cannot
overwrite the recovered data. Verify the target context, available snapshots,
and required encryption keys before any mutation.

A successful backup job proves a snapshot was written, not that the current
cluster can be reconstructed from it. Database dumps, file volumes, and
application encryption keys may be separate recovery dependencies. Workloads
that opt out of backups have no recovery guarantee from this repository.

For manual snapshot inspection, select a concrete snapshot before restoration.
Restic's [tag filters](https://restic.readthedocs.io/en/stable/060_forget.html)
require all tags within a comma-separated list; separate filters can match
alternatives and select another application's snapshot. The historical
script also uses interactive pod attachment, so its attach messages are not a
reliable completion signal.

Routine identity, database, and network changes belong in IaC. The retired
manual override recipes could conflict with reconciliation or target resources
that no longer exist. Emergency repairs still need the explicit authorization
required by [AGENTS.md](../AGENTS.md), followed by reconciliation into code.
