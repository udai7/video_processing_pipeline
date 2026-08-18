# Build the React SPA, then serve it (plus the API/HLS proxy) with nginx.
# Build from the repo root: docker build -f packages/web/Dockerfile .
FROM node:20-alpine AS build
WORKDIR /app
COPY packages/web/package.json packages/web/package-lock.json* ./
RUN npm ci
COPY packages/web/ ./
# Production SPA calls the API at the same origin under /api (served by nginx).
ENV VITE_API_BASE=/api
# Optional Google sign-in client ID, baked in at build time (empty = button hidden).
ARG VITE_GOOGLE_CLIENT_ID=
ENV VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID
RUN npm run build

FROM nginx:1.27-alpine AS runtime
COPY nginx/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
