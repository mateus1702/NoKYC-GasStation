#!/usr/bin/env bash
# Stop stack containers and remove named volumes (deploy-output, valkey-data, etc.).
# Run from anywhere: bash scripts/docker-teardown.sh
# Optional: COMPOSE_FILE=infra/docker/docker-compose.prod.yml bash scripts/docker-teardown.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_FILE="${COMPOSE_FILE:-infra/docker/docker-compose.yml}"

compose_down() {
  if [[ -f .env ]]; then
    docker compose -f "$COMPOSE_FILE" --env-file .env down -v --remove-orphans "$@"
  else
    docker compose -f "$COMPOSE_FILE" down -v --remove-orphans "$@"
  fi
}

echo "[docker-teardown] compose file: $COMPOSE_FILE"
echo "[docker-teardown] running: docker compose ... down -v --remove-orphans"
compose_down "$@"
