# Infrastructure

This project contains the infrastructure-as-code (IaC) for the system.

## Grafana Access

You can use the scripts in the `scripts/` directory to easily access Grafana.

### 1. Port Forward
Run this script in a separate terminal to access Grafana at [http://localhost:3000](http://localhost:3000).

```bash
./scripts/port-forward-grafana.sh
```

### 2. Get Admin Password
Run this script to retrieve and decode the admin user's password.

```bash
./scripts/get-grafana-password.sh
```
