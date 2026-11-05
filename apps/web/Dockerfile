# O contexto de build é a raiz do repositório, porque a imagem inclui infra/Caddyfile.
FROM node:26-slim AS build
WORKDIR /app
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci
COPY apps/web/ ./
RUN npm run build

FROM caddy:2-alpine AS prod
COPY infra/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
