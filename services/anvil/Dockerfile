# Anvil for project4 fork mode (Polygon mainnet fork by default)
FROM ghcr.io/foundry-rs/foundry:latest

ENV ANVIL_HOST=0.0.0.0
ENV ANVIL_PORT=8545
ENV ANVIL_CHAIN_ID=137
ENV ANVIL_BLOCK_TIME=1
ENV ANVIL_ACCOUNTS=1500
ENV ANVIL_MNEMONIC="test test test test test test test test test test test junk"
# ANVIL_FORK_URL: set to https://polygon-rpc.com for fork (default)
# ANVIL_FORK_BLOCK_NUMBER: optional pin for deterministic runs

EXPOSE 8545

WORKDIR /app
RUN mkdir -p /app/state

COPY --chmod=0755 entrypoint-anvil.sh /app/entrypoint-anvil.sh
RUN sed -i 's/\r$//' /app/entrypoint-anvil.sh 2>/dev/null || true

ENTRYPOINT ["sh", "/app/entrypoint-anvil.sh"]
