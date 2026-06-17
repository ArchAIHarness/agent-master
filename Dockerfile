# syntax=docker/dockerfile:1

FROM oven/bun:1.3.13-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.13-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

 COPY --from=deps /app/node_modules ./node_modules
 COPY package.json bun.lock ./
 COPY config.yaml ./
 COPY resources/ ./resources/
 COPY src ./src

 USER bun
EXPOSE 3000
CMD ["bun", "src/server.ts"]
