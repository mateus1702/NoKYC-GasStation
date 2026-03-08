FROM node:20-alpine AS builder
WORKDIR /app

# Install only workspace dependencies needed to compile shared + worker.
COPY package.json package-lock.json* ./
COPY services/shared ./services/shared
COPY services/worker ./services/worker
RUN npm ci --workspace @project4/shared --workspace @project4/worker --include-workspace-root
RUN npm run build -w @project4/shared
RUN npm run build -w @project4/worker
RUN npm prune --omit=dev --workspace @project4/shared --workspace @project4/worker --include-workspace-root

FROM node:20-alpine
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/services/shared/package.json ./services/shared/package.json
COPY --from=builder /app/services/worker/package.json ./services/worker/package.json
COPY --from=builder /app/services/shared/dist ./services/shared/dist
COPY --from=builder /app/services/worker/dist ./services/worker/dist
ENV NODE_PATH=/app/node_modules
WORKDIR /app/services/worker
EXPOSE 8080
CMD ["node", "dist/index.js"]
