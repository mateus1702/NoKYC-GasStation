FROM node:20-alpine AS builder
WORKDIR /app
COPY . ./
RUN npm install
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001
CMD ["node", "server.js"]
