import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { createBackupJob } from "../maintenance/backup";
import { createPVC } from "./k8s-pvc";

export interface BackupConsistencyHook {
  name: string;
  beforeBackup?: pulumi.Input<string[]>;
  afterBackup?: pulumi.Input<string[]>;
}

export interface ManagedVolume {
  name: string;
  mountPath?: string;
  size?: string;
  storageClassName?: string;
  accessModes?: string[];
  pvcName?: string;
  external?: boolean;
  enableBackup?: boolean;
  isEphemeral?: boolean;
  configMap?: k8s.types.input.core.v1.ConfigMapVolumeSource;
  backupConsistencyHook?: BackupConsistencyHook;
}

export interface ManagedVolumeArgs {
  appName: string;
  namespace: pulumi.Input<string>;
  volumes?: ManagedVolume[];
  dependencies?: pulumi.Resource[];
  parent?: pulumi.Resource;
  aliases?: pulumi.Alias[];
}

export interface ManagedVolumeBackupArgs {
  appName: string;
  namespace: pulumi.Input<string>;
  volumes?: ManagedVolume[];
  dependencies?: pulumi.Resource[];
  parent?: pulumi.Resource;
  aliases?: pulumi.Alias[];
}

export interface ManagedVolumePlan {
  pvcs: k8s.core.v1.PersistentVolumeClaim[];
  volumes: k8s.types.input.core.v1.Volume[];
  volumeMounts: k8s.types.input.core.v1.VolumeMount[];
  backupSources: { pvcName: string; mountPath: string; consistencyHook?: BackupConsistencyHook }[];
}

export function planManagedVolumes(args: ManagedVolumeArgs): ManagedVolumePlan {
  const dependencies = args.dependencies ?? [];
  const pvcs: k8s.core.v1.PersistentVolumeClaim[] = [];
  const volumes: k8s.types.input.core.v1.Volume[] = [];
  const volumeMounts: k8s.types.input.core.v1.VolumeMount[] = [];
  const backupSources: ManagedVolumePlan["backupSources"] = [];

  for (const volume of args.volumes ?? []) {
    if (volume.configMap) {
      volumes.push({ name: volume.name, configMap: volume.configMap });
    } else if (volume.isEphemeral) {
      volumes.push({ name: volume.name, emptyDir: {} });
    } else {
      const pvcName = volume.pvcName ?? `${args.appName}-${volume.name}-pvc`;
      if (!volume.external) {
        pvcs.push(createPVC({
          name: pvcName,
          namespace: args.namespace,
          size: volume.size ?? "10Gi",
          storageClassName: volume.storageClassName,
          accessModes: volume.accessModes,
          dependencies,
          parent: args.parent,
          aliases: args.aliases,
        }));
      }

      volumes.push({ name: volume.name, persistentVolumeClaim: { claimName: pvcName } });

      if (!volume.external && volume.enableBackup !== false && volume.mountPath) {
        backupSources.push({
          pvcName,
          mountPath: volume.mountPath,
          consistencyHook: volume.backupConsistencyHook,
        });
      }
    }

    if (volume.mountPath) {
      volumeMounts.push({ name: volume.name, mountPath: volume.mountPath });
    }
  }

  return { pvcs, volumes, volumeMounts, backupSources };
}

export function createManagedVolumeBackups(args: ManagedVolumeBackupArgs, plan: ManagedVolumePlan): k8s.batch.v1.CronJob[] {
  return plan.backupSources.map(source => createBackupJob({
    appName: args.appName,
    namespace: args.namespace,
    source: {
      type: "pvc",
      pvcName: source.pvcName,
      mountPath: source.mountPath,
    },
    dependencies: args.dependencies ?? [],
    parent: args.parent,
    aliases: args.aliases,
  }));
}
