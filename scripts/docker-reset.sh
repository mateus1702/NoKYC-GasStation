#!/usr/bin/env bash
# Teardown stack (down -v) then bring it back: docker compose up -d
# Run from anywhere: bash scripts/docker-reset.sh
# Optional: COMPOSE_FILE=infra/docker/docker-compose.prod.yml bash scripts/docker-reset.sh
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

echo "[docker-reset] compose file: $COMPOSE_FILE"
echo "[docker-reset] step 1/2: down -v --remove-orphans"
compose_down "$@"

if [[ ! -f .env ]]; then
  echo "[docker-reset] error: .env not found; up requires --env-file .env" >&2
  exit 1
fi

echo "[docker-reset] step 2/2: up -d"
docker compose -f "$COMPOSE_FILE" --env-file .env up -d
