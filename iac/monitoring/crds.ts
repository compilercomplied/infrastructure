import * as k8s from "@pulumi/kubernetes";
import * as path from "path";
import * as fs from "fs";

/**
 * Installs the Prometheus Operator Custom Resource Definitions (CRDs).
 *
 * Rationale:
 * We install these CRDs explicitly as a separate step to resolve a race condition
 * driven by Kubernetes API Server Discovery Latency.
 *
 * The Technical Issue:
 * 1.  **Creation vs. Discovery:** When a `CustomResourceDefinition` (CRD) is created, the Kubernetes
 *     API Server accepts the object. However, the REST endpoint for that new Kind (e.g.,
 *     `monitoring.coreos.com/v1/ServiceMonitor`) is not immediately available.
 * 2.  **Discovery Cache:** The API Server's discovery controller must process the CRD and update
 *     the OpenAPI specification. Clients (including the API Server's own validation logic for
 *     dependent resources) rely on this discovery information.
 * 3.  **The Race:** Pulumi optimizes for parallelism. If the Helm chart installs the CRD and
 *     immediately attempts to install a `ServiceMonitor` (which depends on that CRD), the request
 *     often arrives before the API Server has finished publishing the new discovery endpoint.
 *     This results in a "no matches for kind" error, even though the CRD was technically "created".
 *
 * The Solution:
 * We use `k8s.yaml.ConfigFile` to deploy the CRDs first. Crucially, we pass these resources
 * as an explicit `dependsOn` to the Helm chart. This forces Pulumi to wait until the CRD resources
 * report as "Established" (ready) before beginning the Helm Chart deployment, bridging the
 * discovery gap.
 *
 * Source:
 * These YAML files were copied locally from the official Prometheus Operator repository:
 * https://github.com/prometheus-operator/prometheus-operator/tree/v0.88.0/example/prometheus-operator-crd
 * Version: v0.88.0
 */
export function installPrometheusCRDs() {
  const crdDir = path.join(__dirname, "crds");
  const crdFiles = fs.readdirSync(crdDir).filter(file => file.endsWith(".yaml"));

  const resources = crdFiles.map(filename => {
    const name = filename.replace(".yaml", "");
    return new k8s.yaml.ConfigFile(`crd-${name}`, {
      file: path.join(crdDir, filename),
    });
  });

  return resources;
}
