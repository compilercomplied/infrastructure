#!/usr/bin/env sh

set -eu

export MYSQL_PWD="$DB_PASSWORD"

# CNI policy programming can briefly lag Pod startup; retrying the dump here avoids
# turning that transient window into a failed nightly backup or a duplicate snapshot.
attempt=1
while ! mariadb-dump \
  -h "$DB_HOST" \
  -u "$DB_USER" \
  --result-file="$BACKUP_PATH/${DB_NAME}.sql" \
  "$DB_NAME"; do
  if [ "$attempt" -ge 12 ]; then
    echo "MariaDB dump failed after $attempt attempts" >&2
    exit 1
  fi
  echo "MariaDB is not ready; retrying dump in 5 seconds ($attempt/12)" >&2
  attempt=$((attempt + 1))
  sleep 5
done
