import * as k8s from "@pulumi/kubernetes";
import { configureMetrics } from "./metrics";
import { configureLogs } from "./logs";
import { configureTraces } from "./traces";
import { configureOpenTelemetry } from "./opentelemetry";
import { installPrometheusCRDs } from "./crds";

export function configureMonitoring() {
  const monitoringNamespace = new k8s.core.v1.Namespace("monitoring", {
    metadata: { name: "monitoring" }
  });

  const namespaceName = monitoringNamespace.metadata.name;

  const prometheusCRDs = installPrometheusCRDs();

  const metrics = configureMetrics(namespaceName, prometheusCRDs);
  const logs = configureLogs(namespaceName);
  const traces = configureTraces(namespaceName);
  const opentelemetry = configureOpenTelemetry(namespaceName);

  return {
    monitoringNamespace,
    ...metrics,
    ...logs,
    traces,
    opentelemetry,
    prometheusCRDs
  };
}
