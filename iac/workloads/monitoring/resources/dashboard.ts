import { minecraftResources } from "../../games/minecraft-resources";

const prometheus = { type: "prometheus", uid: "prometheus" };
const namespace = 'namespace=~"${namespace:regex}"';
const owner = `max by(namespace,pod,workload,workload_type) (namespace_workload_pod:kube_pod_owner:relabel{${namespace},workload=~"\${workload:regex}"})`;
const active = (scope = "") => `max by(namespace,pod) (kube_pod_status_phase{phase=~"Running|Pending|Unknown"${scope ? `,${scope}` : ""}} == 1)`;
const assigned = 'max by(namespace,pod) (kube_pod_info{node!=""})';

// Container sums omit init-container maxima; completed Jobs must not inflate current reservations.
function podRequests(resource: "cpu" | "memory", scope = "") {
  const match = `resource="${resource}"${scope ? `,${scope}` : ""}`;
  const base = `max by(namespace,pod) (sum by(namespace,pod,resource) (max by(namespace,pod,container,resource) (kube_pod_container_resource_requests{${match}})) or max by(namespace,pod,container,resource) (kube_pod_init_container_resource_requests{${match}}))`;
  const overhead = `max by(namespace,pod) (kube_pod_overhead_${resource === "cpu" ? "cpu_cores" : "memory_bytes"})`;
  return `(((${base}) + on(namespace,pod) (${overhead})) or (${base})) and on(namespace,pod) (${active(scope)})`;
}
const reserved = (resource: "cpu" | "memory") => `sum((${podRequests(resource)}) and on(namespace,pod) (${assigned}))`;
const demand = (resource: "cpu" | "memory") => `sum((${podRequests(resource)}) unless on(namespace,pod) (${assigned})) or vector(0)`;
const capacity = (resource: string) => `sum(max by(node) (kube_node_status_allocatable{resource="${resource}"}))`;
const podMetric = (metric: string) => `max by(namespace,pod,container) (${metric})`;
const selected = (expr: string) => `(${expr}) * on(namespace,pod) group_left(workload,workload_type) (${owner})`;
const currentContainers = `max by(namespace,pod,container) (kube_pod_container_info{${namespace}}) and on(namespace,pod) (${active(namespace)})`;
const live = (expr: string) => `(${expr}) and on(namespace,pod) (${active(namespace)})`;
const perContainer = (expr: string) => `max by(namespace,workload,container) (${selected(expr)})`;
const cpuUsage = perContainer(live(podMetric(`rate(container_cpu_usage_seconds_total{${namespace},container!="",container!="POD"}[5m])`)));
const memoryUsage = perContainer(live(podMetric(`container_memory_working_set_bytes{${namespace},container!="",container!="POD"}`)));
const inventory = perContainer(currentContainers);
const currentOnly = (expr: string) => `(${expr}) and on(namespace,workload,container) (${inventory})`;
const history = (expr: string, operation: string) => currentOnly(`${operation === "p95" ? "quantile_over_time(0.95," : operation + "("}(${expr})[\${history}:5m])`);
const requests = (resource: string) => perContainer(live(podMetric(`kube_pod_container_resource_requests{${namespace},resource="${resource}"}`)));
const limits = (resource: string) => perContainer(live(podMetric(`kube_pod_container_resource_limits{${namespace},resource="${resource}"}`)));
const sizingOwner = `max by(namespace,pod,workload,workload_type) (max_over_time(namespace_workload_pod:kube_pod_owner:relabel{${namespace},workload=~"\${workload:regex}"}[\${history}]))`;
const memoryPeak = currentOnly(`max by(namespace,workload,container) (max by(namespace,pod,container) (max_over_time(container_memory_working_set_bytes{${namespace},container!="",container!="POD"}[\${history}])) * on(namespace,pod) group_left(workload,workload_type) (${sizingOwner}))`);
const limitOrUnset = (resource: string) => `(${limits(resource)}) or on(namespace,workload,container) (-1 * (${inventory}))`;
const withZero = (expr: string) => `(${expr}) or on(namespace,workload,container) (0 * (${inventory}))`;
const keyed = (expr: string) => `label_join((${expr}), "container_key", " / ", "namespace", "workload", "container")`;
const cpuThrottling = perContainer(`100 * (${podMetric(`rate(container_cpu_cfs_throttled_periods_total{${namespace},container!=""}[5m])`)}) / (${podMetric(`rate(container_cpu_cfs_periods_total{${namespace},container!=""}[5m])`)})`);
const historicalOwner = `max by(namespace,pod,workload,workload_type) (max_over_time(namespace_workload_pod:kube_pod_owner:relabel{${namespace},workload=~"\${workload:regex}"}[$__range]))`;
const restarts = `sum by(namespace,workload,container) ((${podMetric(`increase(kube_pod_container_status_restarts_total{${namespace}}[$__range])`)}) * on(namespace,pod) group_left(workload,workload_type) (${historicalOwner}))`;
const oomTimestamp = `max by(namespace,workload,container) (max_over_time((${selected(`max by(namespace,pod,container) (kube_pod_container_status_last_terminated_timestamp{${namespace}} * on(namespace,pod,container,uid) (kube_pod_container_status_last_terminated_reason{${namespace},reason="OOMKilled"} == 1))`)})[$__range:5m]))`;

type Target = { refId: string; expr: string; legendFormat?: string; instant?: boolean; format?: string };
type Position = { x: number; y: number; w: number; h: number };
let panelId = 0;
const fieldDefaults = (unit: string) => ({ unit, min: 0, color: { mode: "palette-classic" } });
function stat(title: string, expr: string, unit: string, position: Position, description: string, mappings: unknown[] = []) {
  return {
    id: ++panelId, title, description, type: "stat", datasource: prometheus, gridPos: position,
    fieldConfig: { defaults: { ...fieldDefaults(unit), mappings, noValue: "No data" }, overrides: [] },
    options: { reduceOptions: { calcs: ["lastNotNull"] }, textMode: "auto", colorMode: "value", graphMode: "none" },
    targets: [{ refId: "A", expr, instant: true }],
  };
}
function graph(title: string, targets: Target[], unit: string, position: Position, description: string) {
  return {
    id: ++panelId, title, description, type: "timeseries", datasource: prometheus, gridPos: position,
    fieldConfig: { defaults: fieldDefaults(unit), overrides: [] },
    options: { legend: { displayMode: "table", placement: "bottom", calcs: ["lastNotNull", "max"] }, tooltip: { mode: "multi", sort: "desc" } },
    targets,
  };
}
function table(title: string, columns: { name: string; expr: string; unit?: string; missing?: string }[], position: Position, description: string, sortBy?: string) {
  const names = Object.fromEntries(columns.map((column, index) => [`Value #${String.fromCharCode(65 + index)}`, column.name]));
  return {
    id: ++panelId, title, description, type: "table", datasource: prometheus, gridPos: position,
    fieldConfig: {
      defaults: { noValue: "No data", custom: { align: "auto", cellOptions: { type: "auto" } } },
      overrides: columns.map(column => ({ matcher: { id: "byName", options: column.name }, properties: [
        { id: "unit", value: column.unit ?? "short" },
        { id: "decimals", value: column.unit === "bytes" ? 1 : 2 },
        { id: "noValue", value: column.missing ?? "No data" },
        { id: "mappings", value: [{ type: "value", options: { "-1": { text: column.missing ?? "Not set" } } }] },
      ] })),
    },
    options: { showHeader: true, cellHeight: "sm", sortBy: [{ displayName: sortBy ?? columns[0].name, desc: true }], footer: { show: false } },
    targets: columns.map((column, index) => ({ refId: String.fromCharCode(65 + index), expr: keyed(column.expr), instant: true, format: "table" })),
    transformations: [
      { id: "joinByField", options: { byField: "container_key", mode: "outerTabular" } },
      { id: "filterFieldsByName", options: { include: { names: ["container_key", ...Object.keys(names)] } } },
      { id: "organize", options: { renameByName: { container_key: "Namespace / workload / container", ...names }, indexByName: Object.fromEntries(["container_key", ...Object.keys(names)].map((name, index) => [name, index])) } },
    ],
  };
}
function rawTable(title: string, expr: string, position: Position, description: string, valueName: string, unit = "short") {
  return {
    id: ++panelId, title, description, type: "table", datasource: prometheus, gridPos: position,
    fieldConfig: { defaults: { unit, noValue: "No data" }, overrides: [] },
    options: { showHeader: true, cellHeight: "sm", sortBy: [{ displayName: valueName, desc: true }] },
    targets: [{ refId: "A", expr, instant: true, format: "table" }],
    transformations: [{ id: "organize", options: { excludeByName: { Time: true }, renameByName: { Value: valueName } } }],
  };
}
const position = (x: number, y: number, w = 6, h = 4) => ({ x, y, w, h });
const workloadMetric = (metric: string, kind: "deployment" | "statefulset") => `max by(namespace,workload) (label_replace(${metric}{${namespace},${kind}=~"\${workload:regex}"},"workload","$1","${kind}","(.+)"))`;

export const resourceDashboard = {
  uid: "cluster-resources",
  title: "Cluster Capacity and Workload Resources",
  description: "Live reservations, actual use, container sizing, and rollout health. Cluster summary ignores filters; workload panels follow namespace/workload filters. Values come from the cluster, not proposed PR settings.",
  tags: ["cluster", "capacity", "resources", "kubernetes"],
  schemaVersion: 39, timezone: "browser", refresh: "1m",
  time: { from: "now-24h", to: "now" },
  links: [
    { title: "Host monitoring", type: "link", url: "/d/afqfch9v03j7kd", targetBlank: false },
    { title: "Storage overview", type: "link", url: "/d/k8s-storage-overview", targetBlank: false },
    { title: "Last 7 days", type: "link", url: "/d/cluster-resources?from=now-7d&to=now&var-history=7d", targetBlank: false },
    { title: "Last 30 days", type: "link", url: "/d/cluster-resources?from=now-30d&to=now&var-history=30d", targetBlank: false },
  ],
  templating: { list: [
    { name: "namespace", label: "Namespace", type: "query", datasource: prometheus, query: { query: "label_values(kube_namespace_created, namespace)", refId: "namespace" }, refresh: 1, multi: true, includeAll: true, allValue: ".*", current: { text: "All", value: "$__all" }, sort: 1 },
    { name: "workload", label: "Workload", type: "query", datasource: prometheus, query: { query: `query_result(count by(workload) ((namespace_workload_pod:kube_pod_owner:relabel{${namespace}} and on(namespace,pod) (${active(namespace)})) or label_replace(kube_deployment_spec_replicas{${namespace},deployment!=""},"workload","$1","deployment","(.+)") or label_replace(kube_statefulset_replicas{${namespace},statefulset!=""},"workload","$1","statefulset","(.+)")))`, refId: "workload" }, regex: '/workload="([^"]+)"/', refresh: 1, multi: true, includeAll: true, allValue: ".*", current: { text: "All", value: "$__all" }, sort: 1 },
    { name: "history", label: "Sizing history", type: "custom", query: "7d,30d", current: { text: "7d", value: "7d" }, options: [{ text: "7d", value: "7d", selected: true }, { text: "30d", value: "30d", selected: false }] },
  ] },
  annotations: { list: [{
    name: "Deployment generation changes", datasource: prometheus, enable: true, hide: true, iconColor: "#5794F2",
    expr: `max by(namespace,deployment) (changes(kube_deployment_metadata_generation{${namespace},deployment=~"\${workload:regex}"}[2m])) > 0`,
    step: "60s", titleFormat: "Configuration changed: {{namespace}}/{{deployment}}",
    textFormat: "Deployment generation changed. This marks a configuration change, not a successful deployment.",
  }] },
  panels: [
    stat("CPU allocatable", capacity("cpu"), "cores", position(0,0), "Cluster-wide CPU available for pod scheduling."),
    stat("CPU allocated requests", reserved("cpu"), "cores", position(6,0), "Cluster-wide requests of assigned, non-terminal pods, including init-container maxima and reported pod overhead."),
    stat("CPU unreserved", `${capacity("cpu")} - (${reserved("cpu")})`, "cores", position(12,0), "Scheduling headroom. This is not idle CPU."),
    stat("Host CPU busy", '1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m]))', "percentunit", position(18,0), "Actual host CPU use, including Kubernetes and host processes."),
    stat("Memory allocatable", capacity("memory"), "bytes", position(0,4), "Cluster-wide memory available for pod scheduling."),
    stat("Memory allocated requests", reserved("memory"), "bytes", position(6,4), "Assigned, non-terminal pod requests; completed Jobs are excluded."),
    stat("Memory unreserved", `${capacity("memory")} - (${reserved("memory")})`, "bytes", position(12,4), "Scheduling headroom. Apps can use more than their requests."),
    stat("Host memory available", "sum(node_memory_MemAvailable_bytes)", "bytes", position(18,4), "Host estimate of memory available to applications, including reclaimable cache. Distinct from unreserved memory."),
    stat("Unscheduled CPU demand", demand("cpu"), "cores", position(0,8), "Requests from non-terminal pods without a node assignment. Excluded from allocated requests."),
    stat("Unscheduled memory demand", demand("memory"), "bytes", position(6,8), "Memory requests waiting for node assignment. Zero does not prove that all assigned pods are healthy."),
    stat("KVM allocated / total", `sum(kube_pod_container_resource_requests{resource="devic_es_kvm"} and on(namespace,pod) (${active()}) and on(namespace,pod) (${assigned})) / ${capacity("devic_es_kvm")}`, "percentunit", position(12,8), "KVM device allocations can prevent scheduling even when CPU and memory fit."),
    stat("Minecraft desired replicas", 'max(kube_deployment_spec_replicas{namespace="game-minecraft",deployment="minecraft"})', "short", position(18,8), `Zero is intentional downtime. Restart requests: ${minecraftResources.requests.cpu} CPU and ${minecraftResources.requests.memory} memory. See rollout health for actual availability.`, [{ type: "value", options: { "0": { text: "Scaled to zero", color: "blue" }, "1": { text: "Enabled", color: "green" } } }]),
    graph("Cluster CPU: allocated, used, and limit budget", [
      { refId: "A", expr: capacity("cpu"), legendFormat: "Allocatable" },
      { refId: "B", expr: reserved("cpu"), legendFormat: "Allocated requests" },
      { refId: "C", expr: 'sum(rate(node_cpu_seconds_total{mode!="idle",mode!="guest",mode!="guest_nice"}[5m]))', legendFormat: "Host used" },
      { refId: "D", expr: `sum(kube_pod_container_resource_limits{resource="cpu"} and on(namespace,pod) (${active()}) and on(namespace,pod) (${assigned}))`, legendFormat: "Explicit CPU limits (partial)" },
    ], "cores", position(0,12,12,8), "Cluster-wide. The sum of limits is an overcommit budget, not a reservation. Containers without CPU limits are not represented in that line."),
    graph("Cluster memory: allocated, used, and limit budget", [
      { refId: "A", expr: capacity("memory"), legendFormat: "Allocatable" },
      { refId: "B", expr: reserved("memory"), legendFormat: "Allocated requests" },
      { refId: "C", expr: 'sum(node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes)', legendFormat: "Host used (total minus available)" },
      { refId: "D", expr: `sum(kube_pod_container_resource_limits{resource="memory"} and on(namespace,pod) (${active()}) and on(namespace,pod) (${assigned}))`, legendFormat: "Explicit memory limits (partial)" },
    ], "bytes", position(12,12,12,8), "Cluster-wide. Host used includes operating-system memory. Limit sums may exceed capacity; they are not guaranteed capacity."),
    graph("Allocated CPU requests by namespace", [{ refId: "A", expr: `sum by(namespace) ((${podRequests("cpu",namespace)}) and on(namespace,pod) (${assigned}))`, legendFormat: "{{namespace}}" }], "cores", position(0,20,12,8), "Namespace filter applies. Includes rollout overlap and running Jobs; excludes completed Jobs. Workload filter does not apply."),
    graph("Allocated memory requests by namespace", [{ refId: "A", expr: `sum by(namespace) ((${podRequests("memory",namespace)}) and on(namespace,pod) (${assigned}))`, legendFormat: "{{namespace}}" }], "bytes", position(12,20,12,8), "Namespace filter applies. An increase confirms live reservations changed; it does not imply actual memory use increased."),
    table("CPU sizing per container — largest replica", [
      { name: "CPU request", expr: withZero(requests("cpu")), unit: "cores" },
      { name: "CPU limit", expr: limitOrUnset("cpu"), unit: "cores", missing: "Unlimited" },
      { name: "CPU now", expr: currentOnly(cpuUsage), unit: "cores" },
      { name: "CPU P95", expr: history(cpuUsage,"p95") , unit: "cores" },
      { name: "CPU peak", expr: history(cpuUsage,"max_over_time"), unit: "cores" },
      { name: "Throttle periods", expr: currentOnly(cpuThrottling), unit: "percent", missing: "No quota / no samples" },
    ], position(0,28,24,10), "One row per workload/container; values are the maximum across replicas, not workload totals. Historical CPU uses five-minute rates and five-minute sampling. Throttled periods are not a percentage of CPU time lost.", "CPU P95"),
    table("Memory sizing per container — largest replica", [
      { name: "Memory request", expr: withZero(requests("memory")), unit: "bytes" },
      { name: "Memory limit", expr: limitOrUnset("memory"), unit: "bytes", missing: "Unlimited" },
      { name: "Memory now", expr: currentOnly(memoryUsage), unit: "bytes" },
      { name: "Memory P95", expr: history(memoryUsage,"p95"), unit: "bytes" },
      { name: "Memory peak", expr: memoryPeak, unit: "bytes" },
      { name: "Peak / current limit", expr: `100 * (${memoryPeak}) / (${limits("memory")})`, unit: "percent", missing: "Unlimited / no samples" },
      { name: "Above request now", expr: `clamp_min((${currentOnly(memoryUsage)}) - (${withZero(requests("memory"))}),0)`, unit: "bytes" },
      { name: "Request above P95", expr: `clamp_min((${withZero(requests("memory"))}) - (${history(memoryUsage,"p95")}),0)`, unit: "bytes" },
      { name: "Sampled days", expr: currentOnly(`count_over_time((${memoryUsage})[\${history}:1h]) / 24`), unit: "d" },
    ], position(0,38,24,12), "Working-set memory: P95 uses five-minute sampling; peak uses all retained scrape samples. History spans pod replacements of the same workload. Peak/current-limit compares historical use with today's limit, which may have changed. Sampled days estimates coverage, not elapsed workload age.", "Above request now"),
    graph("Selected CPU: use, requests, limits", [
      { refId: "A", expr: cpuUsage, legendFormat: "{{namespace}}/{{workload}}/{{container}} used" },
      { refId: "B", expr: requests("cpu"), legendFormat: "{{namespace}}/{{workload}}/{{container}} requested" },
      { refId: "C", expr: limits("cpu"), legendFormat: "{{namespace}}/{{workload}}/{{container}} limit" },
    ], "cores", position(0,50,12,9), "Select a workload to compare its five-minute CPU use and settings. Uses the largest replica at each point."),
    graph("Selected memory: working set, requests, limits", [
      { refId: "A", expr: memoryUsage, legendFormat: "{{namespace}}/{{workload}}/{{container}} used" },
      { refId: "B", expr: requests("memory"), legendFormat: "{{namespace}}/{{workload}}/{{container}} requested" },
      { refId: "C", expr: limits("memory"), legendFormat: "{{namespace}}/{{workload}}/{{container}} limit" },
    ], "bytes", position(12,50,12,9), "Select a workload for readable comparisons. Working set excludes some reclaimable cache; it is not the complete memory-limit accounting."),
    table("Restarts and last observed OOM", [
      { name: "Restarts in view", expr: withZero(currentOnly(restarts)) },
      { name: "Last OOM", expr: `1000 * (${currentOnly(oomTimestamp)})`, unit: "dateTimeFromNow", missing: "None observed in view" },
    ], position(0,59,24,8), "Restart increases span the dashboard time range and are summed across pods. Last OOM is the last recorded OOM termination timestamp observed in this range, not an OOM count. It can predate the range.", "Restarts in view"),
    rawTable("Containers missing resource settings", `label_replace((${selected(currentContainers)}) unless on(namespace,pod,container) (kube_pod_container_resource_requests{resource="memory"}), "missing", "memory request", "", "") or label_replace((${selected(currentContainers)}) unless on(namespace,pod,container) (kube_pod_container_resource_requests{resource="cpu"}), "missing", "CPU request", "", "") or label_replace((${selected(currentContainers)}) unless on(namespace,pod,container) (kube_pod_container_resource_limits{resource="memory"}), "missing", "memory limit", "", "")`, position(0,67,24,9), "Active containers only. An absent CPU limit is allowed and is not flagged. Missing resource settings make capacity or memory safety harder to assess.", "Present"),
    rawTable("Deployment rollout: desired minus available", `clamp_min(${workloadMetric("kube_deployment_spec_replicas","deployment")} - ${workloadMetric("kube_deployment_status_replicas_available","deployment")},0)`, position(0,76,12,8), "Zero means available replicas meet the desired count. A deliberately scaled-to-zero Deployment is healthy here. Positive values identify unavailable replicas.", "Unavailable"),
    rawTable("Deployment rollout: desired minus updated", `clamp_min(${workloadMetric("kube_deployment_spec_replicas","deployment")} - ${workloadMetric("kube_deployment_status_replicas_updated","deployment")},0)`, position(12,76,12,8), "Updated replicas use the latest template; this does not establish application health.", "Not updated"),
    rawTable("StatefulSet rollout: desired minus ready", `clamp_min(${workloadMetric("kube_statefulset_replicas","statefulset")} - ${workloadMetric("kube_statefulset_status_replicas_ready","statefulset")},0)`, position(0,84,12,8), "A positive count identifies a StatefulSet waiting for ready replicas.", "Not ready"),
    rawTable("Pending pods and age", selected(`(time() - max by(namespace,pod) (kube_pod_created{${namespace}})) and on(namespace,pod) (kube_pod_status_phase{phase="Pending"} == 1)`), position(12,84,12,8), "Pod age for Pending pods, not a precise time spent Pending. Empty is normal when no pods are Pending.", "Pod age", "s"),
    rawTable("Container waiting reasons", selected(`max by(namespace,pod,container,reason) (kube_pod_container_status_waiting_reason{${namespace}} == 1) and on(namespace,pod) (${active(namespace)})`), position(0,92,12,8), "Includes CrashLoopBackOff, image-pull errors, and container creation errors when emitted. Empty means no waiting reasons are currently reported.", "Waiting"),
    rawTable("Node pressure", 'max by(node,condition) (kube_node_status_condition{condition=~"Ready|MemoryPressure|DiskPressure|PIDPressure",status="true"})', position(12,92,12,8), "Ready should be 1; pressure conditions should be 0. Cluster-wide, independent of filters.", "Condition true"),
    { id: ++panelId, type: "text", title: "How to read this dashboard", gridPos: position(0,100,24,6), options: { mode: "markdown", content: `**Unreserved is not unused:** requests reserve scheduling capacity; actual use can exceed requests. Explicit limit totals omit unlimited containers.\n\n**Sizing:** choose a namespace/workload and 7d or 30d history. Largest-replica sizing is separate from total cluster reservations. Missing telemetry is not zero usage. CPU uses five-minute rates; memory peaks use retained scrape samples. P95 history is sampled every five minutes. Completed Jobs are excluded from current reservations.\n\n**Minecraft:** desired replicas 0 means intentionally stopped. Restart requests are **${minecraftResources.requests.cpu} CPU / ${minecraftResources.requests.memory} memory**, in addition to other workloads.\n\n**Limits:** no CPU limit can be intentional. Memory near a limit and new OOM terminations need investigation. Last OOM is a timestamp, not a count.\n\nThe dashboard shows live configuration. A PR's proposed settings appear only after deployment.` } },
  ],
};
