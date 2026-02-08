import * as k8s from "@pulumi/kubernetes";
import { configureDocker } from "./modules/docker";
import { configureMonitoring } from "./monitoring";
import { configureTailscale } from "./modules/tailscale";
import { configureAgents } from "./modules/agents";

const { namespace } = configureAgents();

configureDocker(namespace);
configureMonitoring();
configureTailscale();
