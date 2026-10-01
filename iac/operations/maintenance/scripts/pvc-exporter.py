import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STORAGE_PATH = os.environ.get("STORAGE_PATH", "/host/storage")
SCAN_INTERVAL_SECONDS = int(os.environ.get("SCAN_INTERVAL_SECONDS", "300"))
PVC_DIRECTORY_PATTERN = re.compile(
    r"^([a-zA-Z0-9\-]+)_([a-zA-Z0-9\-]+)_([a-zA-Z0-9\-]+)$"
)

cache_lock = threading.Lock()
cached_metrics = b""


def get_dir_size(path):
    total = 0
    errors = 0
    directories = [path]

    while directories:
        directory = directories.pop()
        try:
            with os.scandir(directory) as entries:
                for entry in entries:
                    try:
                        if entry.is_file(follow_symlinks=False):
                            total += entry.stat(follow_symlinks=False).st_size
                        elif entry.is_dir(follow_symlinks=False):
                            directories.append(entry.path)
                    except OSError:
                        errors += 1
        except OSError:
            errors += 1

    return total, errors


def scan_storage():
    started_at = time.time()
    pvc_metrics = []
    scan_errors = 0
    scan_success = 1

    try:
        with os.scandir(STORAGE_PATH) as entries:
            for entry in entries:
                if not entry.is_dir(follow_symlinks=False):
                    continue

                match = PVC_DIRECTORY_PATTERN.match(entry.name)
                if not match:
                    continue

                pv, namespace, pvc = match.groups()
                size, errors = get_dir_size(entry.path)
                scan_errors += errors
                pvc_metrics.append(
                    f'pvc_usage_bytes{{persistentvolumeclaim="{pvc}",namespace="{namespace}",persistentvolume="{pv}"}} {size}'
                )
    except OSError:
        scan_success = 0
        scan_errors += 1

    completed_at = time.time()
    metrics = [
        "# HELP pvc_usage_bytes Apparent size of files in the PVC directory in bytes.",
        "# TYPE pvc_usage_bytes gauge",
        *pvc_metrics,
        "# HELP pvc_exporter_scan_duration_seconds Duration of the latest filesystem scan.",
        "# TYPE pvc_exporter_scan_duration_seconds gauge",
        f"pvc_exporter_scan_duration_seconds {completed_at - started_at}",
        "# HELP pvc_exporter_scan_errors Filesystem entries that could not be inspected during the latest scan.",
        "# TYPE pvc_exporter_scan_errors gauge",
        f"pvc_exporter_scan_errors {scan_errors}",
        "# HELP pvc_exporter_scan_success Whether the latest filesystem scan completed its top-level traversal.",
        "# TYPE pvc_exporter_scan_success gauge",
        f"pvc_exporter_scan_success {scan_success}",
        "# HELP pvc_exporter_last_scan_timestamp_seconds Unix timestamp of the latest completed scan.",
        "# TYPE pvc_exporter_last_scan_timestamp_seconds gauge",
        f"pvc_exporter_last_scan_timestamp_seconds {completed_at}",
    ]

    payload = ("\n".join(metrics) + "\n").encode("utf-8")
    with cache_lock:
        global cached_metrics
        cached_metrics = payload


def scan_loop():
    while True:
        scan_storage()
        time.sleep(SCAN_INTERVAL_SECONDS)


class MetricsHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def do_GET(self):
        if self.path == "/metrics":
            with cache_lock:
                payload = cached_metrics

            self.send_response(200)
            self.send_header("Content-Type", "text/plain; version=0.0.4")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            try:
                self.wfile.write(payload)
            except (BrokenPipeError, ConnectionResetError):
                pass
        elif self.path == "/healthz":
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"ok")
        else:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()


def run():
    scanner = threading.Thread(target=scan_loop, name="pvc-scanner", daemon=True)
    scanner.start()
    server = ThreadingHTTPServer(("0.0.0.0", 9123), MetricsHandler)
    server.serve_forever()


if __name__ == "__main__":
    run()
