#!/bin/bash
echo "Port-forwarding Grafana to http://localhost:3000..."
kubectl port-forward -n monitoring svc/kube-prometheus-stack-grafana 3000:80
