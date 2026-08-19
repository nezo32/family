# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# @family/frontend — Vite 6 + React 19 PWA, served as static files by Caddy.
#
# BUILD CONTEXT IS THE REPOSITORY ROOT, not `frontend/`:
#     docker build -f frontend/Dockerfile -t family-frontend .
#
# Vite inlines every VITE_* variable at BUILD time, so they are build args, not
# runtime env. Changing VITE_API_URL means rebuilding the image — that is the
# nature of a static bundle, not an oversight.
# ─────────────────────────────────────────────────────────────────────────────

ARG NODE_IMAGE=node:24.19.0-alpine3.24
ARG CADDY_IMAGE=caddy:2.11-alpine

# ─────────────────────────────────────────────────────────────
# base — node + pnpm (version pinned by the repo's packageManager field)
# ─────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS base

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true

WORKDIR /app
COPY package.json ./
RUN corepack enable && corepack install

# ─────────────────────────────────────────────────────────────
# deps — manifests + lockfile only, so source edits keep the install cached.
# backend/package.json is included so `--frozen-lockfile` sees the same set of
# workspace importers the lockfile was written against.
# ─────────────────────────────────────────────────────────────
FROM base AS deps

COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json ./packages/shared/
COPY frontend/package.json        ./frontend/
COPY backend/package.json         ./backend/

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --filter "@family/frontend..."

# ─────────────────────────────────────────────────────────────
# build — @family/shared (tsc) then @family/frontend (tsc -b && vite build)
# ─────────────────────────────────────────────────────────────
FROM deps AS build

# Origin only — the client appends /api itself. Empty = same origin.
ARG VITE_API_URL=
ARG VITE_VAPID_PUBLIC_KEY=""
ARG VITE_TELEGRAM_BOT_USERNAME=""

ENV VITE_API_URL=${VITE_API_URL} \
    VITE_VAPID_PUBLIC_KEY=${VITE_VAPID_PUBLIC_KEY} \
    VITE_TELEGRAM_BOT_USERNAME=${VITE_TELEGRAM_BOT_USERNAME} \
    NODE_ENV=production

COPY packages/shared ./packages/shared
COPY frontend ./frontend

# shared first: the frontend's project references / bundler resolution both read
# packages/shared/dist. Building them in one command would race.
RUN pnpm --filter "@family/shared" run build \
 && pnpm --filter "@family/frontend" run build

# ─────────────────────────────────────────────────────────────
# runtime — nothing but the built assets and a static file server.
# No node, no node_modules, no source maps of the toolchain.
# ─────────────────────────────────────────────────────────────
FROM ${CADDY_IMAGE} AS runtime

# Caddy's official image runs as root and writes its state under /data and
# /config. Point both at /tmp and drop to an unprivileged uid instead.
ENV XDG_DATA_HOME=/tmp/caddy-data \
    XDG_CONFIG_HOME=/tmp/caddy-config

RUN adduser -S -D -H -u 10001 -h /srv -s /sbin/nologin static \
 && mkdir -p /tmp/caddy-data /tmp/caddy-config \
 && chown -R 10001 /tmp/caddy-data /tmp/caddy-config

# ── Cache policy — the single most important part of this file ──────────────
# Vite emits content-hashed files under /assets/ and workbox emits hashed
# workbox-*.js. Those are safe to cache forever. Everything else — index.html,
# the service worker, the manifest — MUST be revalidated, otherwise a browser
# keeps serving an old service worker that keeps serving an old index.html that
# points at deleted asset hashes, and the PWA never updates again.
#
# The `@nocache` matcher is a NEGATION of the immutable set rather than an
# explicit file list, because Caddy evaluates `header` before `try_files`: a
# deep link like /tasks is matched here on its ORIGINAL path and only later
# rewritten to /index.html. An explicit `path /index.html` list would therefore
# miss every SPA route.
COPY <<'CADDYFILE' /etc/caddy/Caddyfile
{
	admin off
	auto_https off
	persist_config off
}

:8080 {
	root * /srv
	encode zstd gzip

	header {
		X-Content-Type-Options "nosniff"
		-Server
	}

	@immutable path /assets/* /workbox-*.js
	header @immutable Cache-Control "public, max-age=31536000, immutable"

	@nocache not path /assets/* /workbox-*.js
	header @nocache Cache-Control "no-cache, must-revalidate"

	# Hashed assets: serve the file or 404. Deliberately NO index.html fallback —
	# a stale index referencing a deleted hash must fail loudly, not receive HTML
	# with a text/html content type that the browser tries to execute as JS.
	handle /assets/* {
		file_server
	}

	# Everything else: real file if it exists (sw.js, manifest.webmanifest,
	# icons), otherwise index.html so React Router owns the route.
	handle {
		try_files {path} /index.html
		file_server
	}
}
CADDYFILE

COPY --from=build --chown=10001:0 /app/frontend/dist /srv

USER 10001

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/index.html || exit 1

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
