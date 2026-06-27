import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { createLetsEncryptIngress } from "../library/ingress";
import { createBackupJob } from "../maintenance/backup";

/**
 * Standalone Grafana Visualization Layer
 */
export function configureGrafana(
  namespace: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = []
) {
  const config = new pulumi.Config();
  const adminPassword = config.requireSecret("grafanaAdminPassword");

  const selfhostedConfig = new pulumi.Config("selfhosted");
  const grafanaSecret = selfhostedConfig.requireSecret("grafana-secret");

  const grafana = new k8s.helm.v3.Chart("grafana", {
    namespace: namespace,
    chart: "grafana",
    version: "8.10.1",
    fetchOpts: {
      repo: "https://grafana.github.io/helm-charts",
    },
    values: {
      assertNoLeakedSecrets: false,
      adminPassword: adminPassword,
      persistence: { enabled: true, size: "10Gi", storageClassName: "local-path" },

      plugins: [
        "grafana-lokiexplore-app"
      ],

      "grafana.ini": {
        server: {
          root_url: "https://grafana.gdario.dev",
        },
        plugins: {
          enable_alpha: true,
          allow_loading_unsigned_plugins: "grafana-lokiexplore-app"
        },
        auth: {
          disable_login_form: true,
          oauth_auto_login: true,
        },
        "auth.generic_oauth": {
          enabled: true,
          name: "Authentik",
          allow_sign_up: true,
          client_id: "grafana-client-id",
          client_secret: grafanaSecret,
          scopes: "openid profile email",
          auth_url: "https://auth.gdario.dev/application/o/authorize/",
          token_url: "https://auth.gdario.dev/application/o/token/",
          api_url: "https://auth.gdario.dev/application/o/userinfo/",
          role_attribute_path: "contains(groups[*], 'grafana-admins') && 'Admin' || 'Viewer'",
        }
      },

      service: {
        annotations: {},
      },
      datasources: {
        "datasources.yaml": {
          apiVersion: 1,
          datasources: [
            {
              name: "Prometheus",
              type: "prometheus",
              uid: "prometheus",
              url: "http://kube-prometheus-stack-prometheus:9090",
              access: "proxy",
              isDefault: true,
              jsonData: { httpMethod: "POST", timeInterval: "30s" },
            },
            {
              name: "Loki",
              type: "loki",
              uid: "loki",
              url: "http://loki:3100",
              access: "proxy",
              jsonData: {
                maxLines: 1000,
              },
            },],
        },
      },
      sidecar: {
        dashboards: { enabled: true, label: "grafana_dashboard", labelValue: "1", searchNamespace: "ALL" },
        datasources: { enabled: true, label: "grafana_datasource", labelValue: "1", searchNamespace: "ALL" },
      },
    },
  }, {
    dependsOn: dependencies,
    transformations: [(args: pulumi.ResourceTransformationArgs) => {
      // Kubernetes normalizes rules:[] to null; strip empty arrays to avoid perpetual diff.
      const props = args.props as any;
      if (Array.isArray(props?.rules) && props.rules.length === 0) {
        delete props.rules;
      }
      return { props, opts: args.opts };
    }],
  });

  createLetsEncryptIngress({
    name: "grafana",
    namespace: namespace,
    host: "grafana.gdario.dev",
    serviceName: "grafana",
    servicePort: 80,
    dependencies: [grafana],
  });

  // Back up the Grafana SQLite database and dashboard configuration files
  createBackupJob({
    appName: "grafana",
    namespace: namespace,
    source: {
      type: "pvc",
      pvcName: "grafana",
      mountPath: "/var/lib/grafana",
    },
    dependencies: [grafana],
  });

  return grafana;
}
