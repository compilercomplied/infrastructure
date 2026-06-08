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
