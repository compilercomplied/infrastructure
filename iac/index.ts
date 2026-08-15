import * as k8s from "@pulumi/kubernetes";
import { configureDocker } from "./modules/docker";
import { configureMonitoring } from "./monitoring";
import { configureAgents } from "./modules/agents";
import { configureMaintenance } from "./modules/maintenance";
import { configureSelfhosted } from "./selfhosted";
import { configureCertManager } from "./modules/cert-manager";
import { configureInfrastructure } from "./infrastructure";
import { configureSharedResources } from "./shared-resources";
import { configureForgejo } from "./forgejo";

const { namespace } = configureAgents();

configureDocker(namespace);
configureMonitoring();

configureCertManager();
configureMaintenance();
const selfhosted = configureSelfhosted();
const infrastructure = configureInfrastructure();

// Phase 1: Initialize new namespaces (no workloads migrated yet)
const sharedResources = configureSharedResources();
const forgejo = configureForgejo();
