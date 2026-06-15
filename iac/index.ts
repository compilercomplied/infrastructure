import * as k8s from "@pulumi/kubernetes";
import { configureDocker } from "./modules/docker";
import { configureMonitoring } from "./monitoring";
import { configureAgents } from "./modules/agents";
import { configureMaintenance } from "./modules/maintenance";
import { configureSelfhosted } from "./selfhosted";
import { configureCertManager } from "./modules/cert-manager";

const { namespace } = configureAgents();

configureDocker(namespace);
configureMonitoring();
// Tailscale resources removed since it is not being used at the moment.
// configureTailscale();
configureCertManager();
configureMaintenance();
configureSelfhosted();


