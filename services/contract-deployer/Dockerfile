# Build contracts first, then contract-deployer with artifact
FROM node:22-alpine AS contracts
WORKDIR /build
COPY contracts/package.json contracts/
COPY contracts/contracts contracts/contracts
COPY contracts/hardhat.config.ts contracts/
WORKDIR /build/contracts
RUN npm install && npx hardhat compile --force

FROM node:22-alpine
WORKDIR /app
COPY services/contract-deployer/package.json ./
COPY services/contract-deployer/package-lock.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY services/contract-deployer/src ./src
COPY --from=contracts /build/contracts/artifacts ./contracts-artifacts
ENV CONTRACT_DEPLOYER_CONTRACTS_ARTIFACTS_PATH=/app/contracts-artifacts
ENTRYPOINT ["npm", "run", "start"]
