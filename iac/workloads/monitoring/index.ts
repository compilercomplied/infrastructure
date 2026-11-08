import * as k8s from "@pulumi/kubernetes";
import type { LetsEncryptIngressArgs } from "../../library/ingress";
import { installPrometheusCRDs } from "./crds";
import { configurePrometheus } from "./prometheus";
import { configureGrafana } from "./grafana";
import { configureLoki } from "./loki";
import { configureAlloy } from "./alloy";
import { configurePvcExporter } from "./pvc-exporter";
import { configureBlackboxExporter } from "./blackbox";
import { configureHealthAlerts } from "./health-alerts";

/**
 * Entry point for the modular Monitoring stack.
 */
export function configureMonitoring(grafanaEntryPoints?: LetsEncryptIngressArgs["entryPoints"]) {
  const monitoringNamespace = new k8s.core.v1.Namespace("monitoring", {
    metadata: { name: "monitoring" }
  });

  const namespaceName = monitoringNamespace.metadata.name;

  // 1. Foundations: CRDs
  const prometheusCRDs = installPrometheusCRDs();

  // 2. Data Storage Engines (Prometheus & Loki)
  const prometheus = configurePrometheus(namespaceName, prometheusCRDs);
  const loki = configureLoki(namespaceName);

  // 3. Data Collection Layer (Alloy)
  // We point it to the 'loki' service created by the loki chart
  const alloy = configureAlloy(namespaceName, "loki", [loki]);

  // 4. Visualization Layer (Grafana)
  // Depends on storage engines to ensure service endpoints are available
  const grafana = configureGrafana(namespaceName, [prometheus, loki], grafanaEntryPoints);

  // 5. Expose real PVC disk usage metrics by scanning host directories
  const pvcExporter = configurePvcExporter(namespaceName, prometheusCRDs);

  const blackboxExporter = configureBlackboxExporter(namespaceName, prometheusCRDs);
  const healthAlerts = configureHealthAlerts(namespaceName, prometheusCRDs);

  return {
    monitoringNamespace,
    prometheus,
    loki,
    alloy,
    grafana,
    prometheusCRDs,
    pvcExporter,
    blackboxExporter,
    healthAlerts,
  };
}
