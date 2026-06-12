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
    print("Configuration already exists, skipping seeding.")
    # When migrating tandoor-mcp to the Go-based container, the port changed from 8000 to 8080.
    # We patch the persistent configuration to avoid breaking the connection while preserving other user settings.
    try:
        with open(dest_path, "r") as f:
            content = f.read()
        if "tandoor-mcp.selfhosted.svc.cluster.local:8000" in content:
            updated = content.replace("tandoor-mcp.selfhosted.svc.cluster.local:8000", "tandoor-mcp.selfhosted.svc.cluster.local:8080")
            with open(dest_path, "w") as f:
                f.write(updated)
            print("Successfully migrated tandoor-mcp port from 8000 to 8080 in persistent configuration.")
    except Exception as e:
        print(f"Error migrating configuration: {e}")
