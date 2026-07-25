#!/usr/bin/env python3
import os
import sys
import urllib.request
import urllib.error
import json
from collections import defaultdict

GITEA_HOST = os.environ.get("GITEA_HOST", "http://forgejo.selfhosted.svc.cluster.local:80")
TOKEN_FILE = os.environ.get("GITEA_TOKEN_FILE", "/forgejo-data/gitea/hermes-token.txt")
KEEP_COUNT = 5

try:
    with open(TOKEN_FILE, "r") as f:
        TOKEN = f.read().strip()
except Exception as e:
    print(f"Error reading token file {TOKEN_FILE}: {e}")
    sys.exit(1)

HEADERS = {
    "Authorization": f"token {TOKEN}",
    "Accept": "application/json"
}

def make_request(method, endpoint):
    url = f"{GITEA_HOST}{endpoint}"
    req = urllib.request.Request(url, headers=HEADERS, method=method)
    try:
        with urllib.request.urlopen(req) as response:
            if response.status == 204:
                return None
            body = response.read()
            if body:
                return json.loads(body)
            return None
    except urllib.error.HTTPError as e:
        print(f"HTTPError {e.code} on {method} {endpoint}: {e.read().decode('utf-8', errors='ignore')}")
        return None
    except Exception as e:
        print(f"Error on {method} {endpoint}: {e}")
        return None

def prune_actions():
    print("Fetching repositories...")
    # Fetch all repos (assuming the admin token can see everything). We use a large limit.
    repos = make_request("GET", "/api/v1/repos/search?limit=1000")
    if not repos or "data" not in repos:
        print("Failed to fetch repos.")
        return

    for repo in repos["data"]:
        owner = repo["owner"]["login"]
        name = repo["name"]
        print(f"Checking actions for {owner}/{name}...")
        
        runs = make_request("GET", f"/api/v1/repos/{owner}/{name}/actions/runs?limit=1000")
        if not runs or "workflow_runs" not in runs:
            continue
            
        workflow_runs = runs["workflow_runs"]
        
        # Group by workflow_id or workflow name if we want 5 per workflow,
        # but user said "last 5 action", which usually means overall or per workflow.
        # We will keep last 5 overall for the repo to be safe and literal, 
        # or last 5 per workflow. Let's do last 5 per workflow to be useful.
        runs_by_workflow = defaultdict(list)
        for r in workflow_runs:
            runs_by_workflow[r.get("name", "unknown")].append(r)
            
        for wf_name, wf_runs in runs_by_workflow.items():
            # Sort by created_at descending
            wf_runs.sort(key=lambda x: x.get("created_at", ""), reverse=True)
            to_delete = wf_runs[KEEP_COUNT:]
            
            for run in to_delete:
                run_id = run["id"]
                print(f"  Deleting run {run_id} ({wf_name}) from {owner}/{name}...")
                make_request("DELETE", f"/api/v1/repos/{owner}/{name}/actions/runs/{run_id}")

def prune_packages():
    print("Fetching users and orgs for packages...")
    users = make_request("GET", "/api/v1/admin/users?limit=1000") or []
    orgs = make_request("GET", "/api/v1/admin/orgs?limit=1000") or []
    
    owners = [u["login"] for u in users] + [o["username"] for o in orgs]
    
    for owner in owners:
        print(f"Checking packages for {owner}...")
        packages = make_request("GET", f"/api/v1/packages/{owner}?limit=1000")
        if not packages:
            continue
            
        # Group by type and name
        pkgs_by_name = defaultdict(list)
        for pkg in packages:
            key = f"{pkg['type']}::{pkg['name']}"
            pkgs_by_name[key].append(pkg)
            
        for key, pkgs in pkgs_by_name.items():
            # Sort by created_at descending
            pkgs.sort(key=lambda x: x.get("created_at", ""), reverse=True)
            to_delete = pkgs[KEEP_COUNT:]
            
            for pkg in to_delete:
                ptype = pkg["type"]
                pname = pkg["name"]
                pversion = pkg["version"]
                print(f"  Deleting package {ptype} {pname} {pversion} from {owner}...")
                make_request("DELETE", f"/api/v1/packages/{owner}/{ptype}/{pname}/{pversion}")

if __name__ == "__main__":
    print(f"Starting prune job. Keeping last {KEEP_COUNT} items.")
    prune_actions()
    prune_packages()
    print("Prune job completed.")
