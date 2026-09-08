import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { SelfhostedApp, SelfhostedAppArgs } from "./selfhosted-component";

type HermesAppArgs = Omit<
  SelfhostedAppArgs,
  "namespace" | "dependencies" | "serviceAccountName" | "automountServiceAccountToken" | "childAliases"
>;

export interface HermesAgentArgs {
  namespace: pulumi.Input<string>;
  dependencies?: pulumi.Resource[];
  serviceAccount: {
    name: string;
    clusterRoleName: string;
  };
  app: HermesAppArgs;
}

export class HermesAgent extends pulumi.ComponentResource {
  public readonly deployment: k8s.apps.v1.Deployment;
  public readonly service: k8s.core.v1.Service;
  public readonly ingress: k8s.networking.v1.Ingress;
  public readonly apiIngress: k8s.networking.v1.Ingress;
  public readonly dataBackup: k8s.batch.v1.CronJob;

  constructor(name: string, args: HermesAgentArgs, opts?: pulumi.ComponentResourceOptions) {
    super("custom:selfhosted:HermesAgent", name, {}, opts);

    const { namespace, dependencies = [], serviceAccount, app: appArgs } = args;
    const legacyParentAlias = { parent: pulumi.rootStackResource };
    const account = new k8s.core.v1.ServiceAccount(`${name}-sa`, {
      metadata: { name: serviceAccount.name, namespace },
    }, { parent: this, aliases: [legacyParentAlias] });

    const clusterRoleBinding = new k8s.rbac.v1.ClusterRoleBinding(`${name}-admin-binding`, {
      metadata: { name: `${name}-admin-binding` },
      subjects: [{ kind: "ServiceAccount", name: account.metadata.name, namespace }],
      roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "ClusterRole",
        name: serviceAccount.clusterRoleName,
      },
    }, { parent: this, aliases: [legacyParentAlias] });

    const app = new SelfhostedApp(name, {
      ...appArgs,
      namespace,
      dependencies: [...dependencies, account, clusterRoleBinding],
      serviceAccountName: account.metadata.name,
      automountServiceAccountToken: false,
      childAliases: [{ parent: this }],
    }, { parent: this });

    this.deployment = app.deployment;
    this.service = app.service;
    this.ingress = app.ingresses[0];
    this.apiIngress = app.ingresses[1];
    this.dataBackup = app.backupJobs[0];

    this.registerOutputs({
      deployment: this.deployment,
      service: this.service,
      ingress: this.ingress,
      apiIngress: this.apiIngress,
      dataBackup: this.dataBackup,
    });
  }
}
