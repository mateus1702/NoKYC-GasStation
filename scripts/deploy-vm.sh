#!/usr/bin/env bash
set -euo pipefail

# Deploy flow:
# 1) Build + push production images to Docker Hub
# 2) Backup + upload local compose/env to VM
# 3) SSH to VM
# 4) Stop stack, prune images, pull latest images, restart stack

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DEPLOY_ENV_FILE="${DEPLOY_ENV_FILE:-.deploy-vm.local}"
if [[ -f "$DEPLOY_ENV_FILE" ]]; then
  echo "[deploy-vm] loading local deploy env from $DEPLOY_ENV_FILE"
  set -a
  # shellcheck disable=SC1090
  source "$DEPLOY_ENV_FILE"
  set +a
fi

REMOTE_HOST="${REMOTE_HOST:-root@nokycgas.com}"
if [[ "$REMOTE_HOST" == *"@"* ]]; then
  REMOTE_USER="${REMOTE_HOST%@*}"
  REMOTE_HOSTNAME="${REMOTE_HOST#*@}"
else
  REMOTE_USER="${REMOTE_USER:-root}"
  REMOTE_HOSTNAME="$REMOTE_HOST"
fi
REMOTE_APP_DIR="${REMOTE_APP_DIR:-/root/NoKYC-GasStation}"
REMOTE_COMPOSE_FILE="${REMOTE_COMPOSE_FILE:-infra/docker/docker-compose.prod.yml}"
REMOTE_ENV_FILE="${REMOTE_ENV_FILE:-.env.prod}"
REMOTE_DOCKER_COMPOSE_BIN="${REMOTE_DOCKER_COMPOSE_BIN:-docker-compose}"
LOCAL_COMPOSE_FILE="${LOCAL_COMPOSE_FILE:-infra/docker/docker-compose.prod.yml}"
LOCAL_ENV_FILE="${LOCAL_ENV_FILE:-.env.prod}"
VM_HOSTKEY="${VM_HOSTKEY:-}"

TAG="${TAG:-latest}"
SKIP_PUSH_IMAGES="${SKIP_PUSH_IMAGES:-false}"
DEPLOY_SERVICES="${DEPLOY_SERVICES:-all}"

ALL_SERVICES=(
  contract-deployer
  bundler-alto
  paymaster-api
  config-bootstrap
  dashboard
)
TARGET_SERVICES=()

REMOTE_SSH_OPTS=(
  -o StrictHostKeyChecking=accept-new
)

echo "[deploy-vm] root: $ROOT"
echo "[deploy-vm] host: $REMOTE_HOST"
echo "[deploy-vm] remote user: $REMOTE_USER"
echo "[deploy-vm] remote hostname: $REMOTE_HOSTNAME"
echo "[deploy-vm] remote dir: $REMOTE_APP_DIR"
echo "[deploy-vm] compose file: $REMOTE_COMPOSE_FILE"
echo "[deploy-vm] env file: $REMOTE_ENV_FILE"
echo "[deploy-vm] remote compose bin: $REMOTE_DOCKER_COMPOSE_BIN"
echo "[deploy-vm] local compose file: $LOCAL_COMPOSE_FILE"
echo "[deploy-vm] local env file: $LOCAL_ENV_FILE"
echo "[deploy-vm] skip push images: $SKIP_PUSH_IMAGES"
echo "[deploy-vm] deploy services: $DEPLOY_SERVICES"
echo "[deploy-vm] tag: $TAG"

if [[ ! -f "$LOCAL_COMPOSE_FILE" ]]; then
  echo "[deploy-vm] error: local compose file not found: $LOCAL_COMPOSE_FILE"
  exit 1
fi

if [[ ! -f "$LOCAL_ENV_FILE" ]]; then
  echo "[deploy-vm] error: local env file not found: $LOCAL_ENV_FILE"
  exit 1
fi

if [[ "$TAG" != "latest" ]]; then
  echo "[deploy-vm] warning: compose file references :latest images."
  echo "[deploy-vm] warning: TAG=$TAG is ignored unless compose image tags are changed."
fi

if [[ "$DEPLOY_SERVICES" == "all" ]]; then
  TARGET_SERVICES=("${ALL_SERVICES[@]}")
else
  IFS=',' read -r -a RAW_TARGET_SERVICES <<<"$DEPLOY_SERVICES"
  for raw_service in "${RAW_TARGET_SERVICES[@]}"; do
    service="$(echo "$raw_service" | xargs)"
    if [[ -z "$service" ]]; then
      continue
    fi
    is_known=false
    for known_service in "${ALL_SERVICES[@]}"; do
      if [[ "$service" == "$known_service" ]]; then
        is_known=true
        break
      fi
    done
    if [[ "$is_known" != "true" ]]; then
      echo "[deploy-vm] error: unknown service '$service'."
      echo "[deploy-vm] valid services: ${ALL_SERVICES[*]}"
      exit 1
    fi
    TARGET_SERVICES+=("$service")
  done
fi

if [[ ${#TARGET_SERVICES[@]} -eq 0 ]]; then
  echo "[deploy-vm] error: no deploy services selected."
  exit 1
fi

TARGET_SERVICES_CSV="$(IFS=,; echo "${TARGET_SERVICES[*]}")"
echo "[deploy-vm] resolved target services: ${TARGET_SERVICES[*]}"

echo "[deploy-vm] step 1/4: build production services"
docker compose -f infra/docker/docker-compose.prod.yml build "${TARGET_SERVICES[@]}"

if [[ "$SKIP_PUSH_IMAGES" == "true" ]]; then
  echo "[deploy-vm] step 2/4: skipping image push (SKIP_PUSH_IMAGES=true)"
else
  echo "[deploy-vm] step 2/4: push production images"
  docker compose -f infra/docker/docker-compose.prod.yml push "${TARGET_SERVICES[@]}"
fi

USE_SSHPASS=false
USE_PLINK=false
if command -v sshpass >/dev/null 2>&1 && [[ -n "${SSH_PASSWORD:-}" ]]; then
  USE_SSHPASS=true
elif command -v plink >/dev/null 2>&1 && command -v pscp >/dev/null 2>&1 && [[ -n "${SSH_PASSWORD:-}" ]]; then
  USE_PLINK=true
elif [[ -n "${SSH_PASSWORD:-}" ]]; then
  echo "[deploy-vm] note: SSH_PASSWORD is set but sshpass/plink were not found; falling back to interactive ssh/scp password prompt."
fi

if [[ "$USE_SSHPASS" == "true" ]]; then
  echo "[deploy-vm] ssh auth mode: sshpass"
elif [[ "$USE_PLINK" == "true" ]]; then
  echo "[deploy-vm] ssh auth mode: plink/pscp"
else
  echo "[deploy-vm] ssh auth mode: interactive ssh/scp"
fi

run_ssh() {
  if [[ "$USE_SSHPASS" == "true" ]]; then
    sshpass -p "$SSH_PASSWORD" ssh "${REMOTE_SSH_OPTS[@]}" "$REMOTE_HOST" "$@"
  elif [[ "$USE_PLINK" == "true" ]]; then
    local plink_args=(-batch -ssh -l "$REMOTE_USER" -pw "$SSH_PASSWORD")
    if [[ -n "$VM_HOSTKEY" ]]; then
      plink_args+=(-hostkey "$VM_HOSTKEY")
    fi
    plink "${plink_args[@]}" "$REMOTE_HOSTNAME" "$@"
  else
    ssh "${REMOTE_SSH_OPTS[@]}" "$REMOTE_HOST" "$@"
  fi
}

run_scp() {
  if [[ "$USE_SSHPASS" == "true" ]]; then
    sshpass -p "$SSH_PASSWORD" scp "${REMOTE_SSH_OPTS[@]}" "$1" "$2"
  elif [[ "$USE_PLINK" == "true" ]]; then
    local pscp_args=(-batch -pw "$SSH_PASSWORD")
    if [[ -n "$VM_HOSTKEY" ]]; then
      pscp_args+=(-hostkey "$VM_HOSTKEY")
    fi
    pscp "${pscp_args[@]}" "$1" "$REMOTE_USER@$REMOTE_HOSTNAME:${2#"$REMOTE_HOST:"}"
  else
    scp "${REMOTE_SSH_OPTS[@]}" "$1" "$2"
  fi
}

BACKUP_DIR="backup-deploy-$(date +%Y%m%d-%H%M%S)"
echo "[deploy-vm] step 3/4: backup and upload compose/env on VM ($BACKUP_DIR)"
run_ssh "REMOTE_APP_DIR='$REMOTE_APP_DIR' REMOTE_COMPOSE_FILE='$REMOTE_COMPOSE_FILE' REMOTE_ENV_FILE='$REMOTE_ENV_FILE' BACKUP_DIR='$BACKUP_DIR' bash -s" <<'EOF'
set -euo pipefail
cd "$REMOTE_APP_DIR"
mkdir -p "$BACKUP_DIR"
mkdir -p "$(dirname "$REMOTE_COMPOSE_FILE")"
mkdir -p "$(dirname "$REMOTE_ENV_FILE")"

if [[ -f "$REMOTE_COMPOSE_FILE" ]]; then
  cp "$REMOTE_COMPOSE_FILE" "$BACKUP_DIR/$(basename "$REMOTE_COMPOSE_FILE")"
fi

if [[ -f "$REMOTE_ENV_FILE" ]]; then
  cp "$REMOTE_ENV_FILE" "$BACKUP_DIR/$(basename "$REMOTE_ENV_FILE")"
fi
EOF

run_scp "$LOCAL_COMPOSE_FILE" "$REMOTE_HOST:$REMOTE_APP_DIR/$REMOTE_COMPOSE_FILE"
run_scp "$LOCAL_ENV_FILE" "$REMOTE_HOST:$REMOTE_APP_DIR/$REMOTE_ENV_FILE"

read -r -d '' REMOTE_CMD <<'EOF' || true
set -euo pipefail
cd "$REMOTE_APP_DIR"
IFS=',' read -r -a REMOTE_TARGET_SERVICES <<<"$TARGET_SERVICES_CSV"

if [[ "$DEPLOY_SERVICES" == "all" ]]; then
  echo "[remote] stopping stack"
  "$REMOTE_DOCKER_COMPOSE_BIN" -f "$REMOTE_COMPOSE_FILE" --env-file "$REMOTE_ENV_FILE" down --remove-orphans || true

  echo "[remote] pruning old images"
  docker image prune -af
else
  echo "[remote] partial deploy for services: ${REMOTE_TARGET_SERVICES[*]}"
fi

echo "[remote] pulling latest images"
"$REMOTE_DOCKER_COMPOSE_BIN" -f "$REMOTE_COMPOSE_FILE" --env-file "$REMOTE_ENV_FILE" pull "${REMOTE_TARGET_SERVICES[@]}"

echo "[remote] removing stale target containers"
"$REMOTE_DOCKER_COMPOSE_BIN" -f "$REMOTE_COMPOSE_FILE" --env-file "$REMOTE_ENV_FILE" rm -f -s "${REMOTE_TARGET_SERVICES[@]}" || true

echo "[remote] starting stack"
"$REMOTE_DOCKER_COMPOSE_BIN" -f "$REMOTE_COMPOSE_FILE" --env-file "$REMOTE_ENV_FILE" up -d "${REMOTE_TARGET_SERVICES[@]}"

echo "[remote] done"
EOF

echo "[deploy-vm] step 4/4: run remote update over SSH"
run_ssh "REMOTE_APP_DIR='$REMOTE_APP_DIR' REMOTE_COMPOSE_FILE='$REMOTE_COMPOSE_FILE' REMOTE_ENV_FILE='$REMOTE_ENV_FILE' REMOTE_DOCKER_COMPOSE_BIN='$REMOTE_DOCKER_COMPOSE_BIN' DEPLOY_SERVICES='$DEPLOY_SERVICES' TARGET_SERVICES_CSV='$TARGET_SERVICES_CSV' bash -s" <<<"$REMOTE_CMD"

echo "[deploy-vm] deploy finished successfully"
