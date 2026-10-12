# The bot's runtime image (spec docs/superpowers/specs/2026-10/2026-10-11-wbb-image-deployment-design.md §3.1).
#
#   docker build -f deploy/image/Dockerfile --build-arg SOURCE_SHA=<40 hex> \
#     [--build-arg RUN_ID=… --build-arg RUN_ATTEMPT=…] [--secret id=ca,src=<CA bundle>] .
#
# The build stage makes the same payload as the former runtime artifact (package_runtime.py),
# so the native module is compiled on the runtime's own Debian (bookworm, same glibc). The
# runtime stage gets the payload, the trial and start checks and the content digest, nothing else.
# verify_payload.py does not run here: bookworm's Python 3.11.2 has no tarfile data filter,
# which its safe unpacking requires. Its probes run against the finished image instead, in the
# CI smoke (read-only, no network): payload-probe.cjs native|assets|ops, trial, start-check.
#
# Both bases are pinned by digest from mirror.gcr.io (anonymous Docker Hub gave 429).
# The runtime FROM below carries its digest as a literal, so Dependabot (docker) can bump it: it
# does not resolve build args in FROM. The build stage gets the same digest as RUNTIME_BASE_DIGEST
# from scripts/image-base-digest.sh, which reads that literal (CI and any local build pass it), so
# wbb.content changes exactly when the runtime base does. No default: package_runtime.py refuses
# an empty or malformed digest.

FROM mirror.gcr.io/library/node:24-bookworm@sha256:3d27e5c11e5786e309ec3e03f93ae536eb36e6e5eb3714d5eb3300a36157add0 AS build
WORKDIR /src
COPY . .
# An optional CA bundle for builds behind a TLS-intercepting proxy (local runs); CI passes none.
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi \
 && npm ci --no-audit --no-fund \
 && npx tsc -p tsconfig.release.json --outDir /tmp/dist \
 && mkdir /tmp/prod \
 && cp package.json package-lock.json /tmp/prod/ \
 && cd /tmp/prod && npm ci --omit=dev --no-audit --no-fund

# Declared after the dependency step so a new commit or run reuses its cache.
ARG RUNTIME_BASE_DIGEST
ARG SOURCE_SHA
ARG RUN_ID=0
ARG RUN_ATTEMPT=1
RUN python3 deploy/release/package_runtime.py --repo . --dist /tmp/dist --modules /tmp/prod/node_modules \
      --out /tmp/release --repo-slug ysilvestrov/warsaw-beer-bot --sha "$SOURCE_SHA" \
      --workflow .github/workflows/ci.yml --run-id "$RUN_ID" --run-attempt "$RUN_ATTEMPT" \
      --base-digest "$RUNTIME_BASE_DIGEST" \
 && mkdir -p /tmp/app/deploy/image \
 && cp -a /tmp/release/payload/. /tmp/app/ \
 && cp deploy/trial-migrate.cjs /tmp/app/deploy/trial-migrate.cjs \
 && cp deploy/image/start-check.cjs deploy/image/offline-telegram.cjs /tmp/app/deploy/image/ \
 && cp /tmp/release/content-digest /tmp/app/.content-digest \
 && chmod -R a+rX,a-w /tmp/app

# /app = the payload (exactly what tree-manifest.json lists) plus three files outside it:
#   deploy/trial-migrate.cjs, deploy/image/start-check.cjs  — the host's trial and START steps (§6.3);
#   .content-digest — wbb.content (§4.1), 64 hex + newline. It is computed from tree-manifest.json
#   and the runtime base digest before it exists, and is not in the manifest, so it never feeds
#   itself; CI reads it to set the wbb.content label.
# Modes are set in the build stage (a-w, a+rX): a chmod layer here would copy every file again.
FROM mirror.gcr.io/library/node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
ARG SOURCE_SHA
LABEL org.opencontainers.image.revision="${SOURCE_SHA}" \
      org.opencontainers.image.source="https://github.com/ysilvestrov/warsaw-beer-bot"
COPY --from=build /tmp/app/ /app/
WORKDIR /app
ENV NODE_ENV=production HOME=/tmp
# No USER: the Quadlet unit gives the bot's numeric UID/GID (§3.2).
CMD ["node", "dist/index.js"]
