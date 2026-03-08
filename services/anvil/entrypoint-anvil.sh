#!/bin/sh
# Build anvil args from env; fork URL and block are configurable

set -e

HOST="${ANVIL_HOST}"
PORT="${ANVIL_PORT}"
CHAIN_ID="${ANVIL_CHAIN_ID}"
BLOCK_TIME="${ANVIL_BLOCK_TIME}"
ACCOUNTS="${ANVIL_ACCOUNTS}"
MNEMONIC="${ANVIL_MNEMONIC}"
FORK_URL="${ANVIL_FORK_URL}"
FORK_BLOCK="${ANVIL_FORK_BLOCK_NUMBER}"

if [ -n "$FORK_URL" ]; then
  # Fork mode: omit --state to speed initial startup; Anvil will accept connections once fork loads
  set -- anvil \
    --host "$HOST" \
    --port "$PORT" \
    --chain-id "$CHAIN_ID" \
    --block-time "$BLOCK_TIME" \
    --accounts "$ACCOUNTS" \
    --mnemonic "$MNEMONIC" \
    --fork-url "$FORK_URL"
  if [ -n "$FORK_BLOCK" ]; then
    set -- "$@" --fork-block-number "$FORK_BLOCK"
  fi
else
  # Local mode: use state for persistence
  STATE_DIR="${ANVIL_STATE_DIR}"
  mkdir -p "$STATE_DIR"
  set -- anvil \
    --host "$HOST" \
    --port "$PORT" \
    --chain-id "$CHAIN_ID" \
    --block-time "$BLOCK_TIME" \
    --accounts "$ACCOUNTS" \
    --mnemonic "$MNEMONIC" \
    --state "$STATE_DIR/anvil-state" \
    --state-interval 600
fi

exec "$@"
