import os
import re
from http.server import HTTPServer, BaseHTTPRequestHandler

STORAGE_PATH = "/host/storage"

def get_dir_size(path):
    total = 0
    try:
        for entry in os.scandir(path):
            try:
                if entry.is_file(follow_symlinks=False):
                    total += entry.stat(follow_symlinks=False).st_size
                elif entry.is_dir(follow_symlinks=False):
                    total += get_dir_size(entry.path)
            except Exception:
                pass
    except Exception:
        pass
    return total

class MetricsHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Silence default HTTP server logging to prevent log pollution
        pass

    def do_GET(self):
        if self.path == "/metrics":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; version=0.0.4")
            self.end_headers()
            
            metrics = []
            metrics.append("# HELP pvc_usage_bytes Actual disk space used by the PVC directory in bytes")
            metrics.append("# TYPE pvc_usage_bytes gauge")
            
            if os.path.exists(STORAGE_PATH):
                try:
                    for entry in os.scandir(STORAGE_PATH):
                        if entry.is_dir():
                            # local-path directories match format: <pv-name>_<namespace>_<pvc-name>
                            # e.g., pvc-85676b17-6548-4aac-80c1-3d66efbecc7f_selfhosted_grimmory-books-pvc
                            match = re.match(r"^([a-zA-Z0-9\-]+)_([a-zA-Z0-9\-]+)_([a-zA-Z0-9\-]+)$", entry.name)
                            if match:
                                pv, ns, pvc = match.groups()
                                size = get_dir_size(entry.path)
                                metrics.append(f'pvc_usage_bytes{{persistentvolumeclaim="{pvc}",namespace="{ns}",persistentvolume="{pv}"}} {size}')
                except Exception:
                    pass
            
            self.wfile.write("\n".join(metrics).encode("utf-8"))
            self.wfile.write(b"\n")
        else:
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"Not Found")

def run():
    server = HTTPServer(("0.0.0.0", 9123), MetricsHandler)
    server.serve_forever()

if __name__ == "__main__":
    run()
