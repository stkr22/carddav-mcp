# Build stage
#
# node:26-alpine is the ACTIVE LTS line, not the newest tag — roughly half of all
# Node majors never become LTS, so "newest" and "supported" are different things.
# Only the major belongs in this note. A patch version written here would be
# falsified by the next digest bump, which would arrive red for a reason nobody
# needs to act on. CI checks the claim instead, on every run
# (.github/scripts/check-base-image-pin.sh): `node:lts-alpine` and
# `node:26-alpine` must resolve to the same digest, and the digest pinned below
# must be a Node 26 image. The day 26 leaves LTS, that fails.
FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

# Runtime
FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The server reports its version from package.json at runtime. The lockfile is
# not copied: nothing reads it here, and it is an inventory of the dependency
# tree in an image whose package managers are removed below.
COPY package.json ./

# The base image's bundled package managers are a frequent source of HIGH
# findings and this image never installs anything — remove them rather than
# carrying their CVEs. corepack goes with npm for the same reason: it is a
# package-manager shim in an image whose entrypoint is plain `node`, and so
# is yarn, which the base image also ships.
#
# This does not shrink the image — the files stay in the base layer — but it
# removes them from the final filesystem, which is what Trivy scans and what a
# process in the container can reach.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v*

# Ownership proof for the MCP Registry: must match server.json's name exactly.
LABEL io.modelcontextprotocol.server.name="io.github.ni-c/carddav-mcp"

# Drop root: the node image ships an unprivileged `node` user (uid 1000). This
# server never writes to the filesystem — a PHOTO given as a URI is reported and
# never fetched — so there is no bind mount to chown and nothing else follows
# from it here.
USER node

# stdio transport only — no port, no healthcheck. The server starts without
# credentials (tools stay listable, so registries and inspectors can introspect
# it); every call then fails with setup instructions instead of reaching a server.
ENTRYPOINT ["node", "dist/index.js"]

# ---------------------------------------------------------------------------
# Fork addition (stkr22): Streamable HTTP for in-cluster use. The server only
# speaks stdio, so supergateway serves it on :8000/mcp. This is the last stage,
# so it is the default build target; `--target runtime` gives the stdio image.
# docker/mcp-http/package-lock.json pins the gateway's full dependency tree. It
# overrides zod to 4.x: supergateway still asks for 3.x, which is inside the range
# of a high advisory (GHSA-mrhx-c7xc-m3w5) that has no 3.x fix, and the gateway
# runs fine on 4.x (initialize and tools/list checked through it).
# Inbound auth: docker/mcp-http/entrypoint.sh turns MCP_API_KEYS (comma-separated)
# into supergateway's --apiKey flags and refuses to start without one unless
# MCP_ALLOW_NO_AUTH=true. Clients send `Authorization: Bearer <key>`; /healthz stays
# open for the probes. The network policy in front is still worth having.
# ---------------------------------------------------------------------------
FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS gateway
WORKDIR /gateway
COPY docker/mcp-http/package.json docker/mcp-http/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM runtime AS http
COPY --from=gateway /gateway /gateway
COPY --chmod=0555 docker/mcp-http/entrypoint.sh /gateway/entrypoint.sh
USER node
EXPOSE 8000
ENTRYPOINT ["/gateway/entrypoint.sh"]
