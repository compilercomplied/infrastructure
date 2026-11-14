import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

const prometheus = { type: "prometheus", uid: "prometheus" };
const loki = { type: "loki", uid: "loki" };

const stats = [
  { title: "SSH jail healthy", expr: "fail2ban_up", unit: "none" },
  { title: "Active bans", expr: 'fail2ban_currently_banned{jail="sshd"}', unit: "short" },
  { title: "Bans since jail restart", expr: 'fail2ban_banned_total{jail="sshd"}', unit: "short" },
  { title: "Failures since jail restart", expr: 'fail2ban_failed_total{jail="sshd"}', unit: "short" },
  { title: "Current failed attempts", expr: 'fail2ban_currently_failed{jail="sshd"}', unit: "short" },
  { title: "Metrics age", expr: "time() - fail2ban_metrics_timestamp_seconds", unit: "s" },
];

const dashboard = {
  uid: "host-fail2ban",
  title: "Host SSH and Fail2ban",
  description: "Host SSH jail metrics collected every minute. Total counters reset when Fail2ban or its SSH jail restarts. IP addresses are available in event logs and are not used as metric labels.",
  tags: ["security", "ssh", "fail2ban"],
  schemaVersion: 39,
  timezone: "browser",
  refresh: "1m",
  time: { from: "now-6h", to: "now" },
  panels: [
    ...stats.map((stat, index) => ({
      id: index + 1,
      title: stat.title,
      type: "stat",
      datasource: prometheus,
      gridPos: { x: index * 4, y: 0, w: 4, h: 4 },
      fieldConfig: { defaults: { unit: stat.unit, min: 0, color: { mode: "fixed", fixedColor: "blue" } }, overrides: [] },
      options: { reduceOptions: { calcs: ["lastNotNull"] }, textMode: "auto", colorMode: "value", graphMode: "none" },
      targets: [{ refId: "A", expr: stat.expr, instant: true }],
    })),
    {
      id: 7,
      title: "Failed SSH attempts per minute",
      type: "timeseries",
      datasource: prometheus,
      gridPos: { x: 0, y: 4, w: 12, h: 8 },
      fieldConfig: { defaults: { unit: "short", min: 0 }, overrides: [] },
      targets: [{ refId: "A", expr: 'rate(fail2ban_failed_total{jail="sshd"}[$__rate_interval]) * 60', legendFormat: "{{jail}} failures/min" }],
    },
    {
      id: 8,
      title: "New bans per minute",
      type: "timeseries",
      datasource: prometheus,
      gridPos: { x: 12, y: 4, w: 12, h: 8 },
      fieldConfig: { defaults: { unit: "short", min: 0 }, overrides: [] },
      targets: [{ refId: "A", expr: 'rate(fail2ban_banned_total{jail="sshd"}[$__rate_interval]) * 60', legendFormat: "{{jail}} bans/min" }],
    },
    {
      id: 9,
      title: "Recent ban and unban events",
      type: "logs",
      datasource: loki,
      gridPos: { x: 0, y: 12, w: 24, h: 10 },
      options: { showTime: true, sortOrder: "Descending", enableLogDetails: true },
      targets: [{ refId: "A", expr: '{job="fail2ban"} |~ " (Ban|Unban) "', queryType: "range" }],
    },
  ],
};

export function configureFail2banDashboard(namespace: pulumi.Input<string>) {
  return new k8s.core.v1.ConfigMap("fail2ban-dashboard", {
    metadata: { name: "fail2ban-dashboard", namespace, labels: { grafana_dashboard: "1" } },
    data: { "fail2ban.json": JSON.stringify(dashboard) },
  });
}
