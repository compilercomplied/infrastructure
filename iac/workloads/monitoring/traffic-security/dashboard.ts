const prometheus = { type: "prometheus", uid: "prometheus" };
const lanInterface = 'device="enp0s31f6",job="node-exporter"';
const sshJail = 'jail="sshd",job="node-exporter"';
const podInterface = 'job="kubelet",metrics_path="/metrics/cadvisor",interface="eth0",namespace!="",pod!=""';

type Target = { refId: string; expr: string; legendFormat: string };

function graph(id: number, title: string, description: string, unit: string, x: number, y: number, targets: Target[]) {
  return {
    id, title, description, type: "timeseries", datasource: prometheus,
    gridPos: { x, y, w: 12, h: 8 },
    fieldConfig: { defaults: { unit, min: 0 }, overrides: [] },
    options: { tooltip: { mode: "multi", sort: "desc" } },
    targets,
  };
}

export const trafficSecurityDashboard = {
  uid: "traffic-security",
  title: "Traffic & Security",
  description: "Node LAN traffic, pod network activity, and host SSH failures. Cloudflare edge traffic and router firewall activity are outside this dashboard's coverage.",
  tags: ["network", "security"],
  schemaVersion: 39,
  timezone: "browser",
  refresh: "1m",
  time: { from: "now-24h", to: "now" },
  links: [{ title: "SSH ban details", type: "link", url: "/d/host-fail2ban", keepTime: true }],
  panels: [
    graph(1, "Node LAN throughput", "Traffic on the node's physical LAN interface includes local and internet traffic.", "bps", 0, 0, [
      { refId: "A", expr: `8 * rate(node_network_receive_bytes_total{${lanInterface}}[$__rate_interval])`, legendFormat: "Received" },
      { refId: "B", expr: `8 * rate(node_network_transmit_bytes_total{${lanInterface}}[$__rate_interval])`, legendFormat: "Sent" },
    ]),
    graph(2, "Node LAN packet drops", "Interface drops can indicate congestion or a receive problem. Router and firewall denies are outside this count.", "pps", 12, 0, [
      { refId: "A", expr: `rate(node_network_receive_drop_total{${lanInterface}}[$__rate_interval])`, legendFormat: "Receive drops" },
      { refId: "B", expr: `rate(node_network_transmit_drop_total{${lanInterface}}[$__rate_interval])`, legendFormat: "Transmit drops" },
    ]),
    graph(3, "Host TCP opens", "Node-wide connection opens per second. These counters cannot attribute a spike to a port or distinguish LAN from WAN clients.", "cps", 0, 8, [
      { refId: "A", expr: 'rate(node_netstat_Tcp_PassiveOpens{job="node-exporter"}[$__rate_interval])', legendFormat: "Passive opens" },
      { refId: "B", expr: 'rate(node_netstat_Tcp_ActiveOpens{job="node-exporter"}[$__rate_interval])', legendFormat: "Active opens" },
    ]),
    graph(4, "Host SSH failures and bans", "Failed attempts and new bans per minute from the host SSH jail.", "suffix: /min", 12, 8, [
      { refId: "A", expr: `60 * rate(fail2ban_failed_total{${sshJail}}[$__rate_interval])`, legendFormat: "Failed attempts" },
      { refId: "B", expr: `60 * rate(fail2ban_banned_total{${sshJail}}[$__rate_interval])`, legendFormat: "New bans" },
    ]),
    {
      id: 5,
      title: "Busiest pods by network throughput",
      description: "Receive plus transmit throughput over the final five minutes of the selected range. Includes pod-to-pod traffic. Host-network pods are outside this view.",
      type: "bargauge",
      datasource: prometheus,
      gridPos: { x: 0, y: 16, w: 24, h: 9 },
      fieldConfig: { defaults: { unit: "bps", min: 0, color: { mode: "fixed", fixedColor: "blue" } }, overrides: [] },
      options: { orientation: "horizontal", displayMode: "basic", reduceOptions: { calcs: ["lastNotNull"] } },
      targets: [{
        refId: "A",
        expr: `topk(8, 8 * sum by (namespace, pod) (rate(container_network_receive_bytes_total{${podInterface}}[5m]) + rate(container_network_transmit_bytes_total{${podInterface}}[5m])))`,
        legendFormat: "{{namespace}} / {{pod}}",
        instant: true,
        range: false,
      }],
    },
  ],
};
