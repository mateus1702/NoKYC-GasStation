FROM node:20-alpine
WORKDIR /app
COPY . .
RUN npm install
RUN npm run build -w @project4/shared && npm run build -w @project4/config-bootstrap
CMD ["node", "services/config-bootstrap/dist/index.js"]
