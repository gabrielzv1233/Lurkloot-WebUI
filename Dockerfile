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

# Fetch one exact upstream revision. Nothing under the upstream checkout is
# patched; our package is added as another workspace package below.
RUN git init lurkloot \
    && cd lurkloot \
    && git remote add origin https://github.com/jamezrin/lurkloot.git \
    && git fetch --depth 1 origin "${LURKLOOT_REF}" \
    && git checkout --detach FETCH_HEAD \
    && git rev-parse HEAD > /tmp/lurkloot-sha

WORKDIR /src/lurkloot

# pnpm-workspace.yaml already includes packages/*, so copying this directory is
# enough to make the web host another workspace package without editing upstream.
COPY overlay/ packages/webui/

# The injected package is not present in upstream's committed lockfile, so allow
# pnpm to add only this workspace importer in the disposable build stage.
RUN pnpm install --no-frozen-lockfile --filter @lurkloot/webui...

RUN pnpm --filter @lurkloot/webui build \
    && cp /tmp/lurkloot-sha packages/webui/dist/lurkloot-upstream-sha.txt

FROM nginx:1.29-alpine AS runtime

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/lurkloot/packages/webui/dist/ /usr/share/nginx/html/

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz >/dev/null || exit 1
