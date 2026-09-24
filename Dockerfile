FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY apps ./apps
RUN npm run prisma:generate -w @attendance/api && npm run build

FROM build AS api
ENV NODE_ENV=production
RUN mkdir -p /app/apps/api/uploads && chown -R node:node /app/apps/api/uploads
WORKDIR /app/apps/api
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]

FROM caddy:2-alpine AS web
COPY --from=build /app/apps/web/dist /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile
