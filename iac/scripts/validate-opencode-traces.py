"""Check the deployed Alloy and Tempo configurations with synthetic OTLP data."""
from pathlib import Path
import subprocess
import uuid

MONITORING = Path(__file__).resolve().parents[1] / "workloads" / "monitoring"

PROBE = r'''
import json
import time
import urllib.request

marker = "synthetic_private_payload"
trace_id = "a1" * 16
clock = time.time_ns()


def call(url, value=None):
    body = json.dumps(value).encode() if value else None
    request = urllib.request.Request(url, body, {"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=4) as response:
        return response.read()


def eventually(url):
    deadline = time.monotonic() + 45
    while True:
        try:
            return call(url)
        except OSError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(.5)


def attribute(key, value):
    return {"key": key, "value": {"stringValue": value}}


def span(span_id, name):
    return {
        "traceId": trace_id, "spanId": span_id, "name": name,
        "traceState": "fixture=" + marker,
        "startTimeUnixNano": str(clock), "endTimeUnixNano": str(clock + 100_000_000),
        "attributes": [attribute("ai.prompt", marker), attribute("session.id", "ses_otlp_fixture")],
        "events": [{"timeUnixNano": str(clock), "name": marker, "attributes": [attribute("payload", marker)]}],
        "status": {"code": 2, "message": marker},
    }


eventually("http://tempo:3200/ready")
eventually("http://alloy:12345/-/ready")
model = span("a2" * 8, "ai.streamText")
operation = span("a3" * 8, marker)
linked = span("a4" * 8, "ai.generateText")
linked["links"] = [{"traceId": "a5" * 16, "spanId": "a6" * 8, "attributes": [attribute("payload", marker)]}]
call("http://alloy:4318/v1/traces", {"resourceSpans": [{
    "resource": {"attributes": [attribute("service.name", "opencode"), attribute("payload", marker)]},
    "scopeSpans": [{"scope": {"name": marker, "version": marker, "attributes": [attribute("payload", marker)]},
                    "spans": [model, operation, linked]}],
}]})

stored = eventually("http://tempo:3200/api/traces/" + trace_id).decode()
assert marker not in stored
assert "ai.streamText" in stored and "opencode.operation" in stored
assert "ses_otlp_fixture" in stored
assert "ai.generateText" not in stored
print("Alloy preserved model and session data, scrubbed private payloads, and dropped linked spans.")
'''


def docker(*args, **kwargs):
    return subprocess.run(["docker", *args], text=True, check=True, **kwargs)


def main():
    network = "opencode-traces-" + uuid.uuid4().hex[:12]
    containers = []

    def start(alias, config, image, *args, options=()):
        target = "/tmp/" + config.name
        create = docker("create", "--network", network, "--network-alias", alias, *options, image,
                        *(arg.format(config=target) for arg in args), capture_output=True)
        container = create.stdout.strip()
        containers.append(container)
        docker("cp", str(config), f"{container}:{target}")
        docker("start", container, stdout=subprocess.DEVNULL)

    docker("network", "create", network, stdout=subprocess.DEVNULL)
    try:
        start("tempo", MONITORING / "tempo/tempo.yaml", "grafana/tempo:2.8.4",
              "-config.file={config}", options=("--user", "10001:10001", "--tmpfs", "/var/tempo:uid=10001,gid=10001"))
        start("alloy", MONITORING / "alloy/opencode.alloy", "grafana/alloy:v1.7.5",
              "run", "--server.http.listen-addr=0.0.0.0:12345", "{config}")
        docker("run", "--rm", "-i", "--network", network, "python:3.14.0-alpine", "python3", "-",
               input=PROBE, timeout=150)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        for container in containers:
            subprocess.run(["docker", "logs", "--tail", "20", container], check=False)
        raise
    finally:
        for container in reversed(containers):
            subprocess.run(["docker", "container", "rm", "--force", container], stdout=subprocess.DEVNULL, check=False)
        docker("network", "rm", network, stdout=subprocess.DEVNULL)


if __name__ == "__main__":
    main()
