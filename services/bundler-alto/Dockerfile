FROM ghcr.io/pimlicolabs/alto:latest
WORKDIR /app
COPY preload-config.mjs entrypoint-alto.js /app/
ENTRYPOINT ["node", "/app/entrypoint-alto.js"]
