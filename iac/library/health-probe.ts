import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export type AppHealthCheck =
  | { protocol: "tcp"; interval?: string }
  | { protocol: "http"; path: `/${string}`; interval?: string };

export interface HealthProbeArgs {
  name: string;
  namespace: pulumi.Input<string>;
  service: k8s.core.v1.Service;
  healthCheck: AppHealthCheck;
  parent: pulumi.Resource;
  aliases: pulumi.Alias[];
}

export function createHealthProbe(args: HealthProbeArgs): k8s.apiextensions.CustomResource {
  const host = pulumi.interpolate`${args.name}.${args.namespace}.svc.cluster.local:80`;
  const target = args.healthCheck.protocol === "http"
    ? pulumi.interpolate`http://${host}${args.healthCheck.path}`
    : host;

  return new k8s.apiextensions.CustomResource(`${args.name}-health`, {
    apiVersion: "monitoring.coreos.com/v1",
    kind: "Probe",
    metadata: {
      name: `${args.name}-health`,
      namespace: args.namespace,
      labels: {
        app: args.name,
        "homelab.gdario.dev/health-contract": "v1",
      },
    },
    spec: {
      jobName: pulumi.interpolate`health-${args.namespace}-${args.name}`,
      interval: args.healthCheck.interval ?? "30s",
      scrapeTimeout: "10s",
      module: args.healthCheck.protocol === "http" ? "http_2xx" : "tcp_connect",
      prober: {
        url: "blackbox-exporter.monitoring.svc.cluster.local:9115",
        path: "/probe",
      },
      targets: { staticConfig: { static: [target] } },
    },
  }, { dependsOn: [args.service], parent: args.parent, aliases: args.aliases });
}
