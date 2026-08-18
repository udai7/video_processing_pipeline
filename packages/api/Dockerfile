# Build from the repo root: docker build -f packages/api/Dockerfile .
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
RUN npm ci --workspace @vp/api --include-workspace-root
COPY packages/shared packages/shared
COPY packages/api packages/api
RUN npm run build --workspace @vp/shared && npm run build --workspace @vp/api

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
RUN npm ci --omit=dev --workspace @vp/api --include-workspace-root
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/api/dist packages/api/dist
CMD ["node", "packages/api/dist/server.js"]
