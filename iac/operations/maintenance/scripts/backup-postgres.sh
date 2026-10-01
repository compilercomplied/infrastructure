#!/usr/bin/env sh

set -eu

# CNI policy programming can briefly lag Pod startup; retrying the dump here avoids
# turning that transient window into a failed nightly backup or a duplicate snapshot.
attempt=1
while ! PGPASSWORD="$DB_PASSWORD" pg_dump \
  -h "$DB_HOST" \
  -U "$DB_USER" \
  -d "$DB_NAME" \
  --file "$BACKUP_PATH/${DB_NAME}.sql"; do
  if [ "$attempt" -ge 12 ]; then
    echo "PostgreSQL dump failed after $attempt attempts" >&2
    exit 1
  fi
  echo "PostgreSQL is not ready; retrying dump in 5 seconds ($attempt/12)" >&2
  attempt=$((attempt + 1))
  sleep 5
done
