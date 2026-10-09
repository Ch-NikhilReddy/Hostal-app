# syntax=docker/dockerfile:1

# Production image for the HostelMitra API.
#
# Multi-stage on purpose. The build stage installs devDependencies to run tsc and the
# Prisma CLI; the runtime stage copies neither. That matters more than usual here:
# the Prisma CLI carries a security advisory with no fixed stable version (H-6), so
# keeping it out of the runtime image is the difference between "advisory in a
# devDependency" and "advisory in production".
#
# Verified by `npm run verify-build`, which runs as a build step below: it boots the
# compiled output and fails the image build if the artifact is unusable. A Dockerfile
# that copies files and hopes is how the dist/src/server.js defect reached a
# "successful" build.

# ---------------------------------------------------------------------------
# Stage 1 — build
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /repo

# Copied before the install so the dependency layer is cached across source edits.
COPY package.json package-lock.json ./
COPY api/package.json ./api/
COPY app/package.json ./app/
COPY web/package.json ./web/

# `npm ci` requires the lockfile to be in sync with every workspace manifest, and it
# does not run install scripts for packages that are not needed. --include=dev because
# tsc and prisma are build-time only.
RUN npm ci --include=dev --ignore-scripts=false

COPY api ./api

# Generate the client against the schema. Runs here rather than at container start so
# a broken schema fails the build instead of every request after deployment.
RUN npm run db:generate --workspace @hostelmitra/api

RUN npm run build --workspace @hostelmitra/api

# Boots dist/server.js and asserts the artifact's shape: no tests, no seed, no source
# maps, and a server that answers /health. This is the step that would have caught
# NEW-1 — `npm run build` exiting 0 while emitting a layout `npm start` could not find.
RUN npm run verify-build --workspace @hostelmitra/api -- --shape

# ---------------------------------------------------------------------------
# Stage 2 — runtime
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

# dumb-init gives PID 1 correct signal handling, so SIGTERM reaches Node and the
# graceful shutdown in server.ts actually runs. Without it, `docker stop` kills the
# process immediately and any in-flight payment webhook is dropped mid-capture.
RUN apk add --no-cache dumb-init

ENV NODE_ENV=production \
    PORT=4000 \
    STORAGE_LOCAL_DIR=/app/uploads

WORKDIR /app

# The upload directory has to exist and be owned by the runtime user before the process
# starts. app.ts calls mkdirSync on it, and the process runs as `node` (uid 1000), so
# a bare /var/uploads is not creatable — the container died at boot with EACCES, which
# only shows up when the image is actually run rather than merely built.
RUN mkdir -p /app/uploads && chown -R node:node /app/uploads

# NOTE on STORAGE_DRIVER=local: uploads are ephemeral inside a container. Replacing or
# rebuilding the image loses every hostel photo. That is acceptable for the free tier
# while there is one host and a rebuild is a deliberate act, and it is NOT acceptable
# the moment there are two replicas or a rolling deploy.
#
# Before scaling out, set STORAGE_DRIVER=s3 (or mount a volume at /app/uploads) — the
# code already branches on the driver and nothing else changes. See docs/deployment.md.

# Production dependencies, installed from api/package.json ALONE.
#
# This is not the obvious way to write it. `npm ci` at the workspace root resolves
# every workspace, so the runtime stage ended up with a 494 MB node_modules
# containing React Native (83 MB), @expo (35 MB) and TypeScript (23 MB) — packages the
# API never imports, in a container reachable from the internet. Anything that achieves
# code execution in the API also reached a JavaScript engine and a native toolchain it
# had no business touching. Measured by scripts/probe-image.mjs.
#
# Installing api/package.json as the ROOT package here gives exactly the API's runtime
# tree. The cost, stated plainly: the workspace lockfile does not apply to this
# directory, so the caret-ranged dependencies resolve to the newest matching version at
# build time rather than the pinned one. @prisma/client and prisma are exact-pinned in
# package.json precisely because they matter, and they are unaffected.
#
# The structural fix — a separate lockfile for the API, or dropping the mobile app out
# of the workspace — is recorded in docs/remediation-checklist.md under NEW-4 rather than
# quietly left as a comment here.
COPY api/package.json ./package.json

# The devDependencies are DELETED from the manifest before installing, rather than
# excluded with a flag.
#
# --omit=dev alone was not enough. @prisma/client declares `prisma` as an optional PEER
# dependency and npm installs optional peers to satisfy them, so the Prisma CLI — the
# package carrying the H-6 advisory with no fixed stable version — came back into the
# runtime image and defeated the point of a multi-stage build. --omit=peer did not stop
# it either.
#
# Removing them from the manifest means there is no declaration left for npm to satisfy,
# which is the only reliable way to keep them out. Measured by scripts/probe-image.mjs:
# 181 MB -> 36 MB, prisma and typescript gone, everything else unchanged.
#
# @prisma/client itself still works: it needs the CLI only to regenerate itself, and
# generation already happened in the build stage.
RUN npm pkg delete devDependencies \
 && npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force

COPY --from=build /repo/api/dist ./dist
COPY --from=build /repo/api/prisma ./prisma

# The GENERATED Prisma client, overwriting the un-generated one that npm just
# installed. The generated engine binding lives in .prisma/client, which is why both
# are copied: @prisma/client is the loader, .prisma is the code it loads, and copying
# only the first produces a client that fails at the first query rather than at boot.
#
# Taken from api/node_modules in the build stage because that is where npm placed it —
# @prisma/client declares `prisma` as an optional peer dependency, so it is not hoisted
# to the workspace root. Hard-coding the wrong path would make this build work on one
# machine and fail on another.
COPY --from=build /repo/api/node_modules/@prisma ./node_modules/@prisma
COPY --from=build /repo/api/node_modules/.prisma ./node_modules/.prisma

# Runs unprivileged. The `node` user ships with the base image (uid 1000).
USER node

EXPOSE 4000

# The orchestrator's readiness probe. It returns 503 when the database is unreachable,
# which is what lets a load balancer stop sending traffic to a broken instance rather
# than to every instance at once.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]