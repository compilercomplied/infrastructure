# Architecture decisions

## One node, shared failure domains

The homelab accepts maintenance downtime and node failure in exchange for lower
hardware and operational overhead. A pod restart can recover a process; node-local
storage cannot make a workload available on a different machine. Replicated
application pods alone would not remove this limit.

Shared database engines avoid paying each application's baseline memory cost.
Separate databases and credentials limit application access, but engine failure
and maintenance still affect multiple applications. Use this tradeoff deliberately
when adding a workload with stronger availability or isolation needs.

## Private access is a routing boundary

Cloudflare Tunnel avoids router port forwarding for public web access. Private
access uses a separate Traefik listener because hiding DNS or requiring SSO does
not make a public listener private. Split DNS preserves the application's URL,
TLS identity, cookies, and OIDC callbacks across access paths. Keep routing and
name resolution consistent when changing exposure.

Default-deny ingress makes each required connection an explicit decision rather
than trusting namespace membership. Shared infrastructure is especially sensitive:
an application's need to reach one database does not justify access to its peers.

Application exposure is declared once in `privateAccess:apps` as `public`,
`private`, or `both`. The shared [access policy](../iac/library/app-access.ts)
is loaded once to keep ingress listeners, cluster DNS, and Tailscale split DNS
aligned. Enabling private access provisions its listener, approves the connector
routes, and publishes split DNS together. Cluster clients reach private apps
through the internal private listener, retaining the same hostname and TLS
identity without requiring Tailscale inside each pod.

The [ingress helper](../iac/library/ingress.ts) and
[private-access configuration](../iac/platform/private-access.ts) own the mechanics.

## Agent access is privileged access

A coding agent can run untrusted project commands. Keep its execution environment
separate from host administration. DinD avoids sharing the node's Docker daemon;
it is not a complete security boundary when its container is privileged. Host
journal collection is separated from HTTP serving so an agent can inspect a
snapshot without receiving a host shell. KVM availability in a main container
does not establish that nested DinD containers can use it.

## Backups preserve state, not availability

Database dumps must succeed before a snapshot can count as a successful backup.
Retention is serialized separately from backup creation to avoid concurrent
pruning, and snapshot groups exclude changing pod identities so old groups can
expire. These choices protect restore candidates; they do not prove restoration
works. See [recovery limitations](recovery.md) before treating backup success as a
recovery guarantee. Workloads can explicitly opt out of backups.

## Deployment must survive its own changes

The CI runner is hosted by the infrastructure it deploys. Replacing that runner
can interrupt the update itself. Host provisioning therefore runs independently
of k3s after CI queues it; a successful queueing job is not proof of successful
provisioning. Preserve resource identity and inspect destructive previews before
merging. [Host maintenance](host-maintenance.md) explains the remaining restart
and recovery limits.
