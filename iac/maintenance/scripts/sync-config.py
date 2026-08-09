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

        # Synchronize model configuration block from template to keep OIDC keys and base URLs aligned.
        try:
            with open(src_path, "r") as f:
                src_lines = f.read().splitlines()
            
            src_model_block = []
            in_model = False
            for line in src_lines:
                if line.strip().startswith("model:"):
                    in_model = True
                    src_model_block.append(line)
                elif in_model:
                    if line.startswith(" ") or line.startswith("\t") or line.strip() == "":
                        src_model_block.append(line)
                    else:
                        in_model = False
            
            dest_lines = content.splitlines()
            dest_model_start = -1
            dest_model_end = -1
            in_model = False
            for i, line in enumerate(dest_lines):
                if line.strip().startswith("model:"):
                    in_model = True
                    dest_model_start = i
                elif in_model:
                    if line.startswith(" ") or line.startswith("\t") or line.strip() == "":
                        dest_model_end = i
                    else:
                        in_model = False
                        break
            
            if dest_model_start != -1:
                end_idx = dest_model_end if dest_model_end != -1 else dest_model_start
                dest_lines = dest_lines[:dest_model_start] + src_model_block + dest_lines[end_idx + 1:]
                content = "\n".join(dest_lines) + "\n"
                print("Successfully synced model configuration block from template.")
        except Exception as e:
            print(f"Error syncing model configuration: {e}")

        # Migrate tandoor-mcp port if necessary
        if "tandoor-mcp.selfhosted.svc.cluster.local:8000" in content:
            content = content.replace("tandoor-mcp.selfhosted.svc.cluster.local:8000", "tandoor-mcp.selfhosted.svc.cluster.local:8080")
            print("Successfully migrated tandoor-mcp port from 8000 to 8080.")

        # Migrate forgejo-mcp path if necessary
        if "forgejo-mcp.selfhosted.svc.cluster.local:8000/sse" in content:
            content = content.replace("forgejo-mcp.selfhosted.svc.cluster.local:8000/sse", "forgejo-mcp.selfhosted.svc.cluster.local:8000/mcp")
            print("Successfully migrated forgejo-mcp path from /sse to /mcp.")

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

        # Check if kubernetes mcp server is configured
        if "kubernetes-mcp.selfhosted.svc.cluster.local" not in content:
            # We insert the kubernetes MCP config under mcp_servers:
            lines = content.splitlines()
            mcp_index = -1
            for i, line in enumerate(lines):
                if line.strip().startswith("mcp_servers:"):
                    mcp_index = i
                    break
            
            if mcp_index != -1:
                # Insert the kubernetes definition right under mcp_servers:
                kubernetes_config = [
                    "  kubernetes:",
                    "    url: http://kubernetes-mcp.selfhosted.svc.cluster.local:8000/sse",
                    "    transport: sse"
                ]
                lines = lines[:mcp_index + 1] + kubernetes_config + lines[mcp_index + 1:]
                content = "\n".join(lines) + "\n"
                print("Successfully added kubernetes-mcp to persistent configuration.")
            else:
                # If mcp_servers block was missing entirely, append it
                content += "\nmcp_servers:\n  kubernetes:\n    url: http://kubernetes-mcp.selfhosted.svc.cluster.local:8000/sse\n    transport: sse\n"
                print("Successfully appended mcp_servers block with kubernetes-mcp to persistent configuration.")

        # Check if forgejo mcp server is configured
        if "forgejo-mcp.selfhosted.svc.cluster.local" not in content:
            # We insert the forgejo MCP config under mcp_servers:
            lines = content.splitlines()
            mcp_index = -1
            for i, line in enumerate(lines):
                if line.strip().startswith("mcp_servers:"):
                    mcp_index = i
                    break
            
            if mcp_index != -1:
                # Insert the forgejo definition right under mcp_servers:
                forgejo_config = [
                    "  forgejo:",
                    "    url: http://forgejo-mcp.selfhosted.svc.cluster.local:8000/mcp",
                    "    transport: sse"
                ]
                lines = lines[:mcp_index + 1] + forgejo_config + lines[mcp_index + 1:]
                content = "\n".join(lines) + "\n"
                print("Successfully added forgejo-mcp to persistent configuration.")
            else:
                # If mcp_servers block was missing entirely, append it
                content += "\nmcp_servers:\n  forgejo:\n    url: http://forgejo-mcp.selfhosted.svc.cluster.local:8000/mcp\n    transport: sse\n"
                print("Successfully appended mcp_servers block with forgejo-mcp to persistent configuration.")

        # Check if outline mcp server is configured
        if "outline-mcp.selfhosted.svc.cluster.local" not in content:
            # We insert the outline MCP config under mcp_servers:
            lines = content.splitlines()
            mcp_index = -1
            for i, line in enumerate(lines):
                if line.strip().startswith("mcp_servers:"):
                    mcp_index = i
                    break
            
            if mcp_index != -1:
                # Insert the outline definition right under mcp_servers:
                outline_config = [
                    "  outline:",
                    "    url: http://outline-mcp.selfhosted.svc.cluster.local:8000/sse",
                    "    transport: sse"
                ]
                lines = lines[:mcp_index + 1] + outline_config + lines[mcp_index + 1:]
                content = "\n".join(lines) + "\n"
                print("Successfully added outline-mcp to persistent configuration.")
            else:
                # If mcp_servers block was missing entirely, append it
                content += "\nmcp_servers:\n  outline:\n    url: http://outline-mcp.selfhosted.svc.cluster.local:8000/sse\n    transport: sse\n"
                print("Successfully appended mcp_servers block with outline-mcp to persistent configuration.")

        with open(dest_path, "w") as f:
            f.write(content)

    except Exception as e:
        print(f"Error migrating configuration: {e}")


