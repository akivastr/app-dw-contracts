#!/usr/bin/env bash
# Run a demo scenario on your machine and print the PR description it would produce.
#
#   ./demo/run-local.sh 2-breaking-export-change
#
# Starts a throwaway Postgres in Docker (or uses $PG_URL if you set it to an
# empty database you don't mind wiping), loads the seed, applies the scenario,
# snapshots, prints the summary, then puts the committed snapshot back.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SCENARIO="${1:-}"
if [ -z "$SCENARIO" ] || [ ! -f "demo/scenarios/$SCENARIO.sql" ]; then
  echo "usage: $0 <scenario>"; echo "scenarios:"; ls demo/scenarios | sed 's/\.sql$//; s/^/  /'
  exit 1
fi

if [ -z "${PG_URL:-}" ]; then
  PG_MAJOR="${PG_MAJOR:-16}"
  docker rm -f contracts-demo-pg >/dev/null 2>&1 || true
  docker run -d --name contracts-demo-pg -e POSTGRES_PASSWORD=demo "postgres:$PG_MAJOR" >/dev/null
  trap 'docker rm -f contracts-demo-pg >/dev/null' EXIT
  for _ in $(seq 1 60); do
    docker exec contracts-demo-pg pg_isready -q -h 127.0.0.1 -U postgres && break; sleep 1
  done
  export PG_URL="postgresql://postgres:demo@127.0.0.1:5432/postgres"
  export PG_DUMP="docker exec contracts-demo-pg pg_dump"
  run_sql() { docker exec -i contracts-demo-pg psql -h 127.0.0.1 -U postgres -q -v ON_ERROR_STOP=1; }
else
  run_sql() { PGOPTIONS="-c client_min_messages=warning" psql "$PG_URL" -q -v ON_ERROR_STOP=1; }
  echo "DROP SCHEMA IF EXISTS dw_export, dw_ingest CASCADE; DROP TABLE IF EXISTS public.app_users;" | run_sql
fi

run_sql < demo/seed.sql
run_sql < "demo/scenarios/$SCENARIO.sql"
./scripts/snapshot.sh

echo; echo "===== Files that would change ====="
git status --short -- outbound inbound || true
echo; echo "===== PR description ====="
python3 scripts/summarize.py

# Restore the committed baseline so the repo stays clean.
git checkout -q -- outbound inbound
git clean -qfd -- outbound inbound
