FROM node:20-alpine AS builder
WORKDIR /app
COPY . ./
RUN corepack enable && corepack prepare pnpm@latest --activate
RUN pnpm install --no-frozen-lockfile
RUN pnpm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001
CMD ["node", "server.js"]
