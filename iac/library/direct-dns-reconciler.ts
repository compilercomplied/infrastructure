import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export const directDnsOwnerLabel = "homelab.gdario.dev/direct-dns-owner";

export interface DirectDnsRegistration {
  owner: string;
  hostname: string;
}

export interface DirectDnsReconcilerArgs {
  namespace: pulumi.Input<string>;
  zoneId: string;
  apiToken: pulumi.Input<string>;
  records: DirectDnsRegistration[];
  publicIpv4Endpoint?: string;
  intervalSeconds?: number;
  dependencies?: pulumi.Resource[];
}

function validateZoneId(zoneId: string): void {
  if (!/^[a-f0-9]{32}$/i.test(zoneId)) {
    throw new Error("Cloudflare zone ID must be a 32-character hexadecimal identifier.");
  }
}

function validateIpv4Endpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`Direct DNS public IPv4 endpoint ${endpoint} must be a valid HTTPS URL.`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`Direct DNS public IPv4 endpoint ${endpoint} must use HTTPS.`);
  }
}

function renderReconcilerScript(): string {
  return `set -eu

records_file=/etc/direct-dns/records
api_base=https://api.cloudflare.com/client/v4

require_cloudflare_success() {
  response="$1"
  if ! printf '%s' "$response" | jq -e '.success == true' >/dev/null; then
    # Cloudflare reports authorization and validation failures in an HTTP 200
    # response; surfacing them prevents a silently successful reconciliation.
    printf '%s' "$response" | jq -c '.errors // .messages // .'
    exit 1
  fi
}

ipv4="$(curl --fail --silent --show-error --max-time 10 "$PUBLIC_IPV4_ENDPOINT" | tr -d '\\r\\n')"
case "$ipv4" in
  [0-9]*.[0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "direct-dns: public IPv4 endpoint returned an invalid address" >&2; exit 1 ;;
esac

while IFS='|' read -r owner hostname; do
  [ -n "$owner" ] || continue
  owner_tag="${directDnsOwnerLabel}:$owner"
  record_json="$(curl --fail --silent --show-error --get \\
    --data-urlencode "type=A" \\
    --data-urlencode "name=$hostname" \\
    --data-urlencode "per_page=100" \\
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \\
    -H "Content-Type: application/json" \\
    "$api_base/zones/$CLOUDFLARE_ZONE_ID/dns_records")"
  require_cloudflare_success "$record_json"

  record_id="$(printf '%s' "$record_json" | jq -r '.result | if length == 1 then .[0].id else empty end')"
  if [ -z "$record_id" ]; then
    payload="$(jq -nc --arg hostname "$hostname" --arg ipv4 "$ipv4" --arg owner_tag "$owner_tag" '{type:"A",name:$hostname,content:$ipv4,ttl:1,proxied:false,tags:[$owner_tag]}')"
    response="$(curl --fail --silent --show-error -X POST \\
      -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \\
      -H "Content-Type: application/json" \\
      --data "$payload" \\
      "$api_base/zones/$CLOUDFLARE_ZONE_ID/dns_records")"
    require_cloudflare_success "$response"
    echo "direct-dns: created $hostname"
    continue
  fi

  record_owner="$(printf '%s' "$record_json" | jq -r --arg owner_tag "$owner_tag" '.result[0] | select(.type == "A" and .proxied == false and (.tags | index($owner_tag))) | .id // empty')"
  if [ "$record_owner" != "$record_id" ]; then
    echo "direct-dns: refusing to modify conflicting record $hostname" >&2
    exit 1
  fi

  current_ipv4="$(printf '%s' "$record_json" | jq -r '.result[0].content')"
  if [ "$current_ipv4" = "$ipv4" ]; then
    echo "direct-dns: unchanged $hostname"
    continue
  fi

  payload="$(jq -nc --arg hostname "$hostname" --arg ipv4 "$ipv4" --arg owner_tag "$owner_tag" '{type:"A",name:$hostname,content:$ipv4,ttl:1,proxied:false,tags:[$owner_tag]}')"
  response="$(curl --fail --silent --show-error -X PUT \\
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \\
    -H "Content-Type: application/json" \\
    --data "$payload" \\
    "$api_base/zones/$CLOUDFLARE_ZONE_ID/dns_records/$record_id")"
  require_cloudflare_success "$response"
  echo "direct-dns: reconciled $hostname"
done < "$records_file"
`;
}

export class DirectDnsReconciler extends pulumi.ComponentResource {
  public readonly secret: k8s.core.v1.Secret;
  public readonly records: k8s.core.v1.ConfigMap;
  public readonly cronJob: k8s.batch.v1.CronJob;

  constructor(name: string, args: DirectDnsReconcilerArgs, opts?: pulumi.ComponentResourceOptions) {
    super("custom:gameserver:DirectDnsReconciler", name, {}, opts);

    validateZoneId(args.zoneId);
    const publicIpv4Endpoint = args.publicIpv4Endpoint ?? "https://api.ipify.org";
    validateIpv4Endpoint(publicIpv4Endpoint);
    if (!Number.isInteger(args.intervalSeconds ?? 300) || (args.intervalSeconds ?? 300) < 60) {
      throw new Error("Direct DNS reconciliation interval must be an integer of at least 60 seconds.");
    }
    if (args.records.length === 0) {
      throw new Error("Direct DNS reconciler requires at least one registered hostname.");
    }
    const duplicateHostname = new Set<string>();
    for (const record of args.records) {
      if (!record.owner) {
        throw new Error("Direct DNS registration owner must not be empty.");
      }
      if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(record.hostname)) {
        throw new Error(`Direct DNS hostname ${record.hostname} must be a valid fully-qualified DNS name.`);
      }
      const normalizedHostname = record.hostname.toLowerCase();
      if (duplicateHostname.has(normalizedHostname)) {
        throw new Error(`Direct DNS hostname ${record.hostname} is registered more than once.`);
      }
      duplicateHostname.add(normalizedHostname);
    }

    const dependencies = args.dependencies ?? [];
    const records = args.records.map(registration => `${registration.owner}|${registration.hostname.toLowerCase()}`).join("\n");

    this.secret = new k8s.core.v1.Secret(`${name}-cloudflare-api`, {
      metadata: { name: `${name}-cloudflare-api`, namespace: args.namespace },
      stringData: { "api-token": args.apiToken },
    }, { dependsOn: dependencies, parent: this });

    this.records = new k8s.core.v1.ConfigMap(`${name}-records`, {
      metadata: { name: `${name}-records`, namespace: args.namespace },
      data: { records },
    }, { dependsOn: dependencies, parent: this });

    this.cronJob = new k8s.batch.v1.CronJob(name, {
      metadata: { name, namespace: args.namespace },
      spec: {
        schedule: `*/${Math.max(1, Math.floor((args.intervalSeconds ?? 300) / 60))} * * * *`,
        concurrencyPolicy: "Forbid",
        failedJobsHistoryLimit: 3,
        successfulJobsHistoryLimit: 1,
        jobTemplate: {
          spec: {
            backoffLimit: 2,
            template: {
              metadata: { labels: { app: name } },
              spec: {
                restartPolicy: "OnFailure",
                containers: [{
                  name,
                  image: "alpine:3.22.2",
                  command: ["/bin/sh", "-ec"],
                  args: ["apk add --no-cache curl jq >/dev/null && exec /bin/sh -ec \"$DIRECT_DNS_SCRIPT\""],
                  env: [
                    { name: "CLOUDFLARE_ZONE_ID", value: args.zoneId },
                    { name: "PUBLIC_IPV4_ENDPOINT", value: publicIpv4Endpoint },
                    { name: "DIRECT_DNS_SCRIPT", value: renderReconcilerScript() },
                    {
                      name: "CLOUDFLARE_API_TOKEN",
                      valueFrom: { secretKeyRef: { name: this.secret.metadata.name, key: "api-token" } },
                    },
                  ],
                  volumeMounts: [{ name: "records", mountPath: "/etc/direct-dns", readOnly: true }],
                  resources: {
                    requests: { cpu: "25m", memory: "32Mi" },
                    limits: { cpu: "100m", memory: "64Mi" },
                  },
                  securityContext: {
                    // Alpine packages are installed immediately before this short-lived job
                    // invokes the reconciler; apk requires UID 0 even though the reconciler
                    // otherwise needs no elevated Linux privileges.
                    allowPrivilegeEscalation: false,
                    runAsUser: 0,
                    capabilities: { drop: ["ALL"] },
                  },
                }],
                volumes: [{ name: "records", configMap: { name: this.records.metadata.name } }],
              },
            },
          },
        },
      },
    }, { dependsOn: [this.secret, this.records], parent: this });

    this.registerOutputs({});
  }
}
