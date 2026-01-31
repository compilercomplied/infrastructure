#!/bin/bash
echo -n "Grafana Admin Password: "
kubectl get secret -n monitoring kube-prometheus-stack-grafana -o jsonpath="{.data.admin-password}" | base64 --decode ; echo
