# The operator console, built and served. Build context is the REPO ROOT (like docker/sandbox),
# because the build needs web/ but a Dockerfile under docker/web/ cannot reach up out of its own
# directory. `npm ci` uses web/package-lock.json, so the image is reproducible; the OpenAPI
# schema and the generated TypeScript types are committed (web/openapi.json,
# web/src/api/schema.d.ts) precisely so this image needs Node and nothing else — no Python, no uv.
FROM node:24-alpine AS build
WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# Caddy serves the static build and proxies /api to the API on the HOST (docker/web/Caddyfile).
FROM caddy:2-alpine
COPY docker/web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
