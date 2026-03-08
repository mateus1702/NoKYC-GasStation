FROM node:20-alpine AS builder
WORKDIR /app

# Install and build only workspaces needed by paymaster-api.
COPY package.json package-lock.json* ./
COPY services/shared ./services/shared
COPY services/paymaster-api ./services/paymaster-api
RUN npm ci --workspace @project4/shared --workspace @project4/paymaster-api --include-workspace-root
RUN npm run build -w @project4/shared
RUN npm run build -w @project4/paymaster-api
RUN npm prune --omit=dev --workspace @project4/shared --workspace @project4/paymaster-api --include-workspace-root

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/services/shared/package.json ./services/shared/package.json
COPY --from=builder /app/services/shared/dist ./services/shared/dist
COPY --from=builder /app/services/paymaster-api/package.json ./services/paymaster-api/package.json
COPY --from=builder /app/services/paymaster-api/dist ./services/paymaster-api/dist
ENV NODE_PATH=/app/node_modules
WORKDIR /app/services/paymaster-api
CMD ["node", "dist/server.js"]
