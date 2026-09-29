# syntax=docker/dockerfile:1.7

ARG LURKLOOT_REF=develop

FROM node:24-slim AS build
ARG LURKLOOT_REF
ENV LURKLOOT_REF=${LURKLOOT_REF}

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

WORKDIR /src

RUN git init lurkloot \
    && cd lurkloot \
    && git remote add origin https://github.com/jamezrin/lurkloot.git \
    && git fetch --depth 1 origin "${LURKLOOT_REF}" \
    && git checkout --detach FETCH_HEAD \
    && git rev-parse HEAD > /tmp/lurkloot-sha

WORKDIR /src/lurkloot

# The upstream workspace already includes packages/*, so the WebUI remains an
# additive host package. No Lurkloot source files are patched.
COPY overlay/ packages/webui/

RUN pnpm install --no-frozen-lockfile --filter @lurkloot/webui...
RUN pnpm --filter @lurkloot/webui build \
    && cp /tmp/lurkloot-sha packages/webui/dist/lurkloot-upstream-sha.txt

FROM node:24-alpine AS runtime

RUN apk add --no-cache ca-certificates

WORKDIR /app
COPY --from=build /src/lurkloot/packages/webui/dist/ ./dist/
COPY --from=build /src/lurkloot/packages/webui/server/ ./server/

ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=8s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/health >/dev/null || exit 1

CMD ["node", "/app/server/index.mjs"]
