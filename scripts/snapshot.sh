#!/usr/bin/env bash
# Snapshot the contract schemas into outbound/ and inbound/, one file per object.
#
#   PG_URL            connection string (read-only role is enough)
#   OUTBOUND_SCHEMAS  comma-separated schemas the warehouse reads   (default: dw_export)
#   INBOUND_SCHEMAS   comma-separated schemas the warehouse writes  (default: dw_ingest)
#   PG_DUMP           pg_dump command; must be >= the server's major version (default: pg_dump)
set -euo pipefail
: "${PG_URL:?set PG_URL}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTBOUND_SCHEMAS="${OUTBOUND_SCHEMAS:-dw_export}"
INBOUND_SCHEMAS="${INBOUND_SCHEMAS:-dw_ingest}"
PG_DUMP="${PG_DUMP:-pg_dump}"

snapshot() {
  local out="$1" schemas="$2" args=()
  for s in ${schemas//,/ }; do args+=(--schema="$s"); done
  # shellcheck disable=SC2086  # PG_DUMP may be a multi-word command (e.g. docker run ...)
  $PG_DUMP "$PG_URL" --schema-only --no-owner --no-privileges --lock-wait-timeout=30s "${args[@]}" \
    | node "$ROOT/scripts/split-schema.ts" --out "$ROOT/$out" --strict
}

snapshot outbound "$OUTBOUND_SCHEMAS"
snapshot inbound "$INBOUND_SCHEMAS"
