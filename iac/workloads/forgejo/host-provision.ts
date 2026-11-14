import * as fs from "fs";
import * as path from "path";
import * as forgejo from "@pulumi/forgejo";
import * as pulumi from "@pulumi/pulumi";

export function configureHostProvisionAccess(provider: forgejo.Provider, dependencies: pulumi.Resource[] = []) {
  const privateKey = new pulumi.Config("forgejo").requireSecret("hostProvisionPrivateKey").apply(value => {
    const key = value.trim();
    if (!key.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----\n") || !key.endsWith("-----END OPENSSH PRIVATE KEY-----")) {
      throw new Error("forgejo:hostProvisionPrivateKey must contain an OpenSSH private key");
    }
    return `${key}\n`;
  });
  // The pin is obtained through the authenticated administrator connection, never ssh-keyscan/TOFU in CI.
  const knownHosts = fs.readFileSync(path.join(__dirname, "../../../ansible/roles/host_security/files/host-provision-known-hosts"), "utf8");
  if (!/^192\.168\.50\.200 ssh-ed25519 [A-Za-z0-9+/=]+\n$/.test(knownHosts)) {
    throw new Error("Host provisioning requires the declared server's Ed25519 host-key pin");
  }
  const repository = forgejo.getRepositoryOutput({ owner: "home", name: "homelab-iac" }, { provider, dependsOn: dependencies });
  const options = { provider, protect: true, dependsOn: dependencies };
  const key = new forgejo.RepositoryActionSecret("homelab-host-provision-key", {
    repositoryId: repository.id,
    name: "HOST_SSH_KEY",
    data: privateKey,
  }, options);
  const hostPin = new forgejo.RepositoryActionSecret("homelab-host-provision-known-hosts", {
    repositoryId: repository.id,
    name: "HOST_SSH_KNOWN_HOSTS",
    data: knownHosts,
  }, options);
  return { key, hostPin };
}
