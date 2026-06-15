import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export interface PVCArgs {
  name: string;
  namespace: pulumi.Input<string>;
  size?: string; // defaults to "10Gi"
  storageClassName?: string; // defaults to "local-path"
  accessModes?: string[]; // defaults to ["ReadWriteOnce"]
  dependencies?: pulumi.Resource[];
}

// Configures a standardized Kubernetes PersistentVolumeClaim to eliminate boilerplate and enforce defaults.
export function createPVC(args: PVCArgs): k8s.core.v1.PersistentVolumeClaim {
  const {
    name,
    namespace,
    size = "10Gi",
    storageClassName = "local-path",
    accessModes = ["ReadWriteOnce"],
    dependencies = [],
  } = args;

  return new k8s.core.v1.PersistentVolumeClaim(name, {
    metadata: {
      name,
      namespace,
    },
    spec: {
      accessModes,
      storageClassName,
      resources: {
        requests: {
          storage: size,
        },
      },
    },
  }, { dependsOn: dependencies, deleteBeforeReplace: true });
}
