import os
import time
import json
import urllib.request
import urllib.error
from http.server import HTTPServer, BaseHTTPRequestHandler

# API key must be injected via environment variables.
API_KEY = os.environ.get("DEEPSEEK_API_KEY")
PORT = int(os.environ.get("PORT", "9124"))

# Default cache duration is 5 minutes (300 seconds) because billing balance changes 
# slowly and we must protect the DeepSeek API endpoint from excessive scraping.
CACHE_DURATION_SECS = int(os.environ.get("CACHE_DURATION_SECS", "300"))

# Using globals to maintain state inside the container lifecycle.
last_fetch_time = 0.0
cached_metrics = []

# Exchange rate global state with reasonable default fallbacks.
# We update these dynamically to keep conversions accurate over time.
last_rate_fetch = 0.0
usd_to_eur = 0.92
cny_to_eur = 0.13

def update_exchange_rates():
    global last_rate_fetch, usd_to_eur, cny_to_eur
    current_time = time.time()
    
    # Update rates at most once every 12 hours (43200 seconds) to avoid extra network calls.
    if current_time - last_rate_fetch < 43200:
        return
        
    try:
        req = urllib.request.Request(
            "https://open.er-api.com/v6/latest/USD",
            headers={"Accept": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            if resp.status == 200:
                data = json.loads(resp.read().decode("utf-8"))
                rates = data.get("rates", {})
                eur_rate = rates.get("EUR")
                cny_rate = rates.get("CNY")
                
                if eur_rate:
                    usd_to_eur = eur_rate
                if eur_rate and cny_rate:
                    cny_to_eur = eur_rate / cny_rate
                
                last_rate_fetch = current_time
    except Exception:
        # Silently fail and use fallback values to maintain high availability of the exporter.
        pass

def fetch_deepseek_balance():
    global last_fetch_time, cached_metrics
    
    current_time = time.time()
    
    # Return cache if still fresh to avoid rate limit issues.
    if current_time - last_fetch_time < CACHE_DURATION_SECS and cached_metrics:
        return cached_metrics, None

    if not API_KEY:
        return None, "DEEPSEEK_API_KEY environment variable is not configured"

    # Refresh exchange rates before serving metrics.
    update_exchange_rates()

    url = "https://api.deepseek.com/user/balance"
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {API_KEY}",
            "Accept": "application/json"
        }
    )

    try:
        # A timeout of 10s is specified to prevent hanging requests in case of API degradation.
        with urllib.request.urlopen(req, timeout=10) as response:
            if response.status != 200:
                return None, f"DeepSeek API returned status code {response.status}"
            
            data = json.loads(response.read().decode("utf-8"))
            
            metrics = []
            
            # deepseek_api_available serves as a liveness probe metric for the API's endpoint.
            metrics.append("# HELP deepseek_api_available DeepSeek API availability status (1 = available, 0 = unavailable)")
            metrics.append("# TYPE deepseek_api_available gauge")
            is_avail = 1 if data.get("is_available") else 0
            metrics.append(f"deepseek_api_available {is_avail}")

            balance_infos = data.get("balance_infos", [])
            
            metrics.append("# HELP deepseek_balance_total DeepSeek API total balance")
            metrics.append("# TYPE deepseek_balance_total gauge")
            metrics.append("# HELP deepseek_balance_granted DeepSeek API granted balance (free credits)")
            metrics.append("# TYPE deepseek_balance_granted gauge")
            metrics.append("# HELP deepseek_balance_topped_up DeepSeek API topped up balance (purchased credits)")
            metrics.append("# TYPE deepseek_balance_topped_up gauge")

            for info in balance_infos:
                currency = info.get("currency", "USD")
                total = float(info.get("total_balance", "0"))
                granted = float(info.get("granted_balance", "0"))
                topped_up = float(info.get("topped_up_balance", "0"))

                # Output original currency metric
                metrics.append(f'deepseek_balance_total{{currency="{currency}"}} {total}')
                metrics.append(f'deepseek_balance_granted{{currency="{currency}"}} {granted}')
                metrics.append(f'deepseek_balance_topped_up{{currency="{currency}"}} {topped_up}')

                # Expose automatically converted EUR metrics to support the user's localized billing tracking.
                if currency != "EUR":
                    eur_rate = usd_to_eur if currency == "USD" else cny_to_eur
                    
                    total_eur = round(total * eur_rate, 4)
                    granted_eur = round(granted * eur_rate, 4)
                    topped_up_eur = round(topped_up * eur_rate, 4)

                    metrics.append(f'deepseek_balance_total{{currency="EUR"}} {total_eur}')
                    metrics.append(f'deepseek_balance_granted{{currency="EUR"}} {granted_eur}')
                    metrics.append(f'deepseek_balance_topped_up{{currency="EUR"}} {topped_up_eur}')

            cached_metrics = metrics
            last_fetch_time = current_time
            return metrics, None

    except urllib.error.HTTPError as e:
        # Graceful fallback: return the stale cache if the API fails, preventing immediate alerting flags.
        if cached_metrics:
            return cached_metrics, None
        return None, f"HTTP Error {e.code}: {e.reason}"
    except urllib.error.URLError as e:
        if cached_metrics:
            return cached_metrics, None
        return None, f"URL Error: {e.reason}"
    except Exception as e:
        if cached_metrics:
            return cached_metrics, None
        return None, f"Unexpected error: {str(e)}"

class MetricsHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Prevent web request logs from spamming Kubernetes logs.
        pass

    def do_GET(self):
        if self.path == "/metrics":
            metrics, err = fetch_deepseek_balance()
            if err:
                self.send_response(500)
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(f"Failed to fetch metrics: {err}\n".encode("utf-8"))
                return

            self.send_response(200)
            self.send_header("Content-Type", "text/plain; version=0.0.4")
            self.end_headers()
            self.wfile.write("\n".join(metrics).encode("utf-8"))
            self.wfile.write(b"\n")
        else:
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"Not Found")

def run():
    # Listen on all interfaces so the service endpoint can scrape it from outside the pod.
    server = HTTPServer(("0.0.0.0", PORT), MetricsHandler)
    server.serve_forever()

if __name__ == "__main__":
    run()
