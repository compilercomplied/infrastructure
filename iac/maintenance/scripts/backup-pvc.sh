#!/usr/bin/env bash

# Exit immediately if a command exits with a non-zero status.
set -e

echo "Installing restic..."
apk add --no-cache restic

echo "Checking restic repository status..."
restic snapshots >/dev/null 2>&1 || restic init

echo "Backing up volume directory $BACKUP_PATH..."
restic backup "$BACKUP_PATH" --tag pvc --tag "$APP_NAME"

echo "Pruning old snapshots according to retention policy..."
restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 12 --prune
echo "Backup process completed successfully!"
