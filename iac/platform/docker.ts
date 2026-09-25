import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

class GithubConfiguration {
  constructor(
    readonly username: string,
    readonly password: pulumi.Output<string>,
    readonly email: string
  ) {
  }
}
const pulumiConfig = new pulumi.Config();
const config = new GithubConfiguration(
  pulumiConfig.require("ghcrUsername"),
  pulumiConfig.requireSecret("ghcrPassword"),
  pulumiConfig.require("ghcrEmail")
);


export function configureDocker(namespace: pulumi.Input<string>) {
  const dockerConfig = pulumi.all([config.username, config.password])
    .apply(([username, password]) => {
      return JSON.stringify({
        "auths": {
          "ghcr.io": {
            "username": username,
            "password": password,
            "email": config.email,
            "auth": Buffer.from(`${username}:${password}`).toString("base64"),
          },
        },
      });
    });

  const secret = new k8s.core.v1.Secret("ghcr-secret", {
    metadata: { namespace },
    type: "kubernetes.io/dockerconfigjson",
    data: {
      ".dockerconfigjson": dockerConfig.apply(c => Buffer.from(c).toString("base64")),
    },
  });

  new k8s.core.v1.ServiceAccountPatch("patch-default-service-account", {
    metadata: {
      name: "default",
      namespace: namespace,
    },
    imagePullSecrets: [{ name: secret.metadata.name }],
  });
}
