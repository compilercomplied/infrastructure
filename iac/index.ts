import * as k8s from "@pulumi/kubernetes";
import { configureDocker } from "./modules/docker";
import { configureMonitoring } from "./monitoring";
import { configureTailscale } from "./modules/tailscale";

const agentsNamespace = new k8s.core.v1.Namespace("agents", {
    metadata: { name: "agents" }
});

configureDocker(agentsNamespace.metadata.name);
configureMonitoring();
configureTailscale();
