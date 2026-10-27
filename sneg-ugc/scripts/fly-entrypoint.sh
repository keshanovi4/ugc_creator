#!/bin/sh
set -eu
umask 077

if [ "$(id -u)" = "0" ]; then
  database="${DATABASE_PATH:-/app/data/pilot.sqlite}"
  case "$database" in
    /app/data/*) ;;
    *) echo 'DATABASE_PATH must be inside /app/data' >&2; exit 1 ;;
  esac
  case "$database" in
    */../*|*/./*|*/) echo 'Invalid DATABASE_PATH' >&2; exit 1 ;;
  esac
  if [ -L /app/data ] || [ -L /app/data/backups ]; then
    echo 'Volume directories must not be symlinks' >&2
    exit 1
  fi
  mkdir -p /app/data/backups
  chown node:node /app/data /app/data/backups
  for file in "$database" "$database-wal" "$database-shm"; do
    if [ -L "$file" ]; then
      echo 'Database files must not be symlinks' >&2
      exit 1
    fi
    if [ -f "$file" ]; then chown node:node "$file"; fi
  done
  exec su-exec node:node "$@"
fi

exec "$@"
