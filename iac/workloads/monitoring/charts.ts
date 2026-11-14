export const monitoringCharts = {
  "grafana": {
    chart: "grafana",
    // renovate: datasource=helm depName=grafana registryUrl=https://grafana.github.io/helm-charts
    version: "8.15.0",
    fetchOpts: { repo: "https://grafana.github.io/helm-charts" },
  },
  "alloy": {
    chart: "alloy",
    // renovate: datasource=helm depName=alloy registryUrl=https://grafana.github.io/helm-charts
    version: "0.12.6",
    fetchOpts: { repo: "https://grafana.github.io/helm-charts" },
  },
  "loki": {
    chart: "loki",
    // renovate: datasource=helm depName=loki registryUrl=https://grafana.github.io/helm-charts
    version: "6.55.0",
    fetchOpts: { repo: "https://grafana.github.io/helm-charts" },
  },
  "kube-prometheus-stack": {
    chart: "kube-prometheus-stack",
    // renovate: datasource=helm depName=kube-prometheus-stack registryUrl=https://prometheus-community.github.io/helm-charts
    version: "81.6.9",
    fetchOpts: { repo: "https://prometheus-community.github.io/helm-charts" },
  },
};
