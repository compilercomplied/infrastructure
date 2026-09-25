#!/usr/bin/env bash

# Exit immediately if a command exits with a non-zero status.
set -e

if ! command -v restic >/dev/null 2>&1; then
  echo "Installing restic..."
  if command -v apk >/dev/null 2>&1; then
    apk add --no-cache restic
  elif command -v apt-get >/dev/null 2>&1; then
    apt-get update && apt-get install -y restic
  else
    echo "Unsupported package manager. Please install restic manually."
    exit 1
  fi
fi

echo "Checking restic repository status..."
restic snapshots >/dev/null 2>&1 || restic init

echo "Performing MariaDB database dump and streaming to restic..."
export MYSQL_PWD="$DB_PASSWORD"
mariadb-dump -h "$DB_HOST" -u "$DB_USER" "$DB_NAME" | \
  restic backup --stdin --stdin-filename "${DB_NAME}.sql" --tag database --tag mariadb --tag "$APP_NAME"

echo "Pruning old snapshots according to retention policy..."
restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 12 --prune
echo "Backup process completed successfully!"
