import os
import shutil

src_path = "/opt/config-src/config.yaml"
dest_path = "/opt/data/config.yaml"

# First-boot seeding: copy the template configuration to the Persistent Volume
# only if it does not already exist. This gives the user/container 100% ownership
# over the configuration after initialization, enabling UI changes without risk
# of getting overwritten on pod restarts.
if not os.path.exists(dest_path):
    try:
        shutil.copy(src_path, dest_path)
        print("Seed configuration successfully initialized.")
    except Exception as e:
        print(f"Error seeding configuration: {e}")
        exit(1)
else:
    print("Configuration already exists, checking for missing mcp_servers.")
    try:
        with open(dest_path, "r") as f:
            content = f.read()

        # Migrate tandoor-mcp port if necessary
        if "tandoor-mcp.selfhosted.svc.cluster.local:8000" in content:
            content = content.replace("tandoor-mcp.selfhosted.svc.cluster.local:8000", "tandoor-mcp.selfhosted.svc.cluster.local:8080")
            print("Successfully migrated tandoor-mcp port from 8000 to 8080.")

        # Check if grafana mcp server is configured
        if "grafana-mcp.selfhosted.svc.cluster.local" not in content:
            # We insert the grafana MCP config under mcp_servers:
            lines = content.splitlines()
            mcp_index = -1
            for i, line in enumerate(lines):
                if line.strip().startswith("mcp_servers:"):
                    mcp_index = i
                    break
            
            if mcp_index != -1:
                # Insert the grafana definition right under mcp_servers:
                grafana_config = [
                    "  grafana:",
                    "    url: http://grafana-mcp.selfhosted.svc.cluster.local:8000/sse",
                    "    transport: sse"
                ]
                lines = lines[:mcp_index + 1] + grafana_config + lines[mcp_index + 1:]
                content = "\n".join(lines) + "\n"
                print("Successfully added grafana-mcp to persistent configuration.")
            else:
                # If mcp_servers block was missing entirely, append it
                content += "\nmcp_servers:\n  grafana:\n    url: http://grafana-mcp.selfhosted.svc.cluster.local:8000/sse\n    transport: sse\n"
                print("Successfully appended mcp_servers block with grafana-mcp to persistent configuration.")

        # Check if filesystem mcp server is configured
        if "filesystem-mcp.selfhosted.svc.cluster.local" not in content:
            # We insert the filesystem MCP config under mcp_servers:
            lines = content.splitlines()
            mcp_index = -1
            for i, line in enumerate(lines):
                if line.strip().startswith("mcp_servers:"):
                    mcp_index = i
                    break
            
            if mcp_index != -1:
                # Insert the filesystem definition right under mcp_servers:
                filesystem_config = [
                    "  filesystem:",
                    "    url: http://filesystem-mcp.selfhosted.svc.cluster.local:3000/sse",
                    "    transport: sse"
                ]
                lines = lines[:mcp_index + 1] + filesystem_config + lines[mcp_index + 1:]
                content = "\n".join(lines) + "\n"
                print("Successfully added filesystem-mcp to persistent configuration.")
            else:
                # If mcp_servers block was missing entirely, append it
                content += "\nmcp_servers:\n  filesystem:\n    url: http://filesystem-mcp.selfhosted.svc.cluster.local:3000/sse\n    transport: sse\n"
                print("Successfully appended mcp_servers block with filesystem-mcp to persistent configuration.")

        with open(dest_path, "w") as f:
            f.write(content)

    except Exception as e:
        print(f"Error migrating configuration: {e}")


