FROM node:20-alpine AS build
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/contracts/package.json packages/contracts/package.json

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
RUN pnpm install --frozen-lockfile

# Build contracts first (dependency)
COPY packages/contracts packages/contracts
RUN pnpm --filter @release-agent/contracts build

# Build worker
COPY apps/worker apps/worker
RUN pnpm --filter @release-agent/worker build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

# Copy built worker
COPY --from=build /app/apps/worker/dist apps/worker/dist
# Copy production dependencies
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/apps/worker/node_modules apps/worker/node_modules

CMD ["node", "apps/worker/dist/index.js"]

