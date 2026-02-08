# Infrastructure

This project contains the infrastructure-as-code (IaC) for the system.

Tailscale is used to securely expose services like Grafana.

## Local Deployment

To deploy the infrastructure to your local k3s cluster:

1. **Navigate to the IaC directory**:
   ```bash
   cd iac
   ```

2. **Select the local stack**:
   ```bash
   pulumi stack select local
   ```

3. **Install dependencies**:
   ```bash
   npm install
   ```

4. **Deploy**:
   ```bash
   pulumi up
   ```

## Grafana Access

You can use the scripts in the `scripts/` directory to easily access Grafana locally via port-forwarding.

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
