# Kubernetes Monitoring Stack - Refactor Summary

**Status:** Operational (via Manual Patches)
**Date:** April 5, 2026

## ⚠️ CRITICAL: IAC SYNC WARNING
The current working state of **Alloy** was achieved through **manual `kubectl` patches**. 
**The Pulumi code (`iac/monitoring/alloy.ts`) might be out of sync with the cluster.** 

If you run `mise run deploy` or `pulumi up`, Pulumi may attempt to revert the following manual fixes:
1. **Host Mounts**: Manually added `/var/log` hostPath mount to the Alloy DaemonSet.
2. **ConfigMap**: Manually applied the `alloy` ConfigMap with the surgical `replacement = "/var/log/pods/${1}_${2}_${3}/${4}/*.log"` regex.

---

## 1. Architectural Changes
The monolithic `kube-prometheus-stack` has been decentralized into standalone modules:
- `prometheus.ts`: Prometheus Operator + TSDB (Alertmanager/Grafana disabled here).
- `grafana.ts`: Standalone Grafana deployment via official Helm chart.
- `loki.ts`: Loki 3.x in `SingleBinary` mode with TSDB schema.
- `alloy.ts`: Modern log agent (replaces Promtail) using `discovery.relabel` and `loki.source.file`.

## 2. Key Bug Fixes
- **Grafana Provisioning**: Fixed a type mismatch where `apiVersion` was a String instead of an **Integer (1)**, which crashed the Grafana YAML unmarshaler.
- **Loki Explore App**: Installed the `grafana-lokiexplore-app` plugin and enabled `allow_loading_unsigned_plugins` in `grafana.ini`.
- **Tailscale**: Restored Grafana exposure via Tailscale annotations.
- **Loki Data Source**: Added `maxLines: 1000` and correctly nested the `datasources.yaml` structure.

## 3. Alloy (Log Ingestion) Final Logic
The logs are now successfully ingested using:
- **Path Construction**: `/var/log/pods/<ns>_<pod>_<uid>/<container>/*.log`.
- **Labels**: 1:1 mapping of `namespace`, `pod`, `container`, `node_name`, and `app`.
- **Compatibility**: The `app` label is explicitly mapped to `service_name` and `job` to support the Grafana "Explore Logs" interface.

## 4. Maintenance Commands
- **Check Status**: `kubectl get pods -n monitoring`
- **View Alloy Logs**: `kubectl logs -n monitoring -l app.kubernetes.io/name=alloy`
- **Get Grafana Password**: `scripts/get-grafana-password.sh`
