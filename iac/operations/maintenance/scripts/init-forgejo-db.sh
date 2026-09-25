#!/usr/bin/env bash
set -e

# Wait for database connectivity to handle slow pod startup and CNI NetworkPolicy programming delay.
echo "Checking database connectivity to ${DB_HOST}..."
export PGPASSWORD="${ADMIN_PASSWORD}"

for i in $(seq 1 30); do
  if psql -h "${DB_HOST}" -U postgres -c "SELECT 1" >/dev/null 2>&1; then
    echo "Database connectivity established."
    break
  fi
  echo "Database not ready yet, retrying in 2 seconds... (attempt $i/30)"
  sleep 2
done

# Ensure database role/user exists and is configured.
echo "Ensuring database role '${DB_USER}' exists..."
psql -h "${DB_HOST}" -U postgres -tc "SELECT 1 FROM pg_roles WHERE rolname = '${DB_USER}'" | grep -q 1 || \
  psql -h "${DB_HOST}" -U postgres -c "CREATE USER \"${DB_USER}\" WITH PASSWORD '${DB_PASSWORD}';"

# Ensure database exists and is owned by the application user.
echo "Ensuring database '${DB_NAME}' exists..."
psql -h "${DB_HOST}" -U postgres -tc "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" | grep -q 1 || \
  psql -h "${DB_HOST}" -U postgres -c "CREATE DATABASE \"${DB_NAME}\" OWNER \"${DB_USER}\";"

# Ensure all privileges are granted, including schema public privileges (PostgreSQL 15+).
echo "Configuring privileges..."
psql -h "${DB_HOST}" -U postgres -c "GRANT ALL PRIVILEGES ON DATABASE \"${DB_NAME}\" TO \"${DB_USER}\";"
psql -h "${DB_HOST}" -U postgres -d "${DB_NAME}" -c "GRANT ALL ON SCHEMA public TO \"${DB_USER}\";"

echo "Database initialization complete."
