FROM node:20-alpine AS builder
WORKDIR /app

# Install workspaces needed for dashboard (shared + dashboard).
COPY package.json package-lock.json* ./
COPY services/shared ./services/shared
COPY services/dashboard ./services/dashboard
RUN npm ci --workspace @project4/shared --workspace @project4/dashboard --include-workspace-root
RUN npm run build -w @project4/shared
RUN npm run build -w @project4/dashboard

FROM node:20-alpine
RUN apk add --no-cache docker-cli docker-cli-compose
WORKDIR /app
# Monorepo standalone output: server.js lives under services/dashboard/ (see outputFileTracingRoot).
COPY --from=builder /app/services/dashboard/.next/standalone ./
COPY --from=builder /app/services/dashboard/.next/static ./services/dashboard/.next/static
ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001
CMD ["node", "services/dashboard/server.js"]
