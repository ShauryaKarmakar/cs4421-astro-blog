FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build \
    && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080
WORKDIR /app

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/migrations ./migrations
# Copy only the two production scripts. Local diagnostic scripts are ignored
# by .dockerignore and must never be shipped in the runtime image.
COPY --from=build --chown=node:node /app/scripts/start.mjs ./scripts/start.mjs
COPY --from=build --chown=node:node /app/scripts/migrate.mjs ./scripts/migrate.mjs
# scripts/migrate.mjs imports this shared PostgreSQL TLS configuration.
COPY --from=build --chown=node:node /app/src/lib/postgresConfig.mjs /app/src/lib/postgresConfig.mjs

# The PostgreSQL CA is injected at runtime from AWS Secrets Manager
# (SUPABASE_CA_CERT); no certificate is baked into the image.

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then((response) => process.exit(response.status === 200 ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "./scripts/start.mjs"]
