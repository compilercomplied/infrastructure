#!/usr/bin/env sh

set -eu

set -- \
  --host "$BACKUP_ID" \
  --tag "$BACKUP_KIND" \
  --tag "$APP_NAME"

if [ -n "${BACKUP_ENGINE:-}" ]; then
  set -- "$@" --tag "$BACKUP_ENGINE"
fi

if [ -n "${BACKUP_FILE:-}" ]; then
  restic --retry-lock 15m backup \
    --stdin \
    --stdin-filename "$BACKUP_FILE" \
    "$@" < "$BACKUP_PATH/$BACKUP_FILE"
else
  restic --retry-lock 15m backup "$BACKUP_PATH" "$@"
fi
