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

# Build API
COPY apps/api apps/api
RUN pnpm --filter @release-agent/api build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

# Copy built API
COPY --from=build /app/apps/api/dist apps/api/dist
# Copy production dependencies
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/apps/api/node_modules apps/api/node_modules

EXPOSE 8080
CMD ["node", "apps/api/dist/index.js"]

