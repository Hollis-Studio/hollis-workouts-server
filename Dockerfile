# syntax=docker/dockerfile:1.7
# ============================================================
# Hollis Workouts Server — production Dockerfile
# Stage 1: builder — install deps, generate Prisma client, compile TS
# Stage 2: runner  — lean non-root runtime image
#
# Shared deps (@hollis-studio/contracts, @hollis-studio/auth-client) are
# installed from GitHub Packages, NOT cloned. `npm ci` therefore needs an
# .npmrc carrying the registry mapping + token. The committed ./.npmrc is NOT
# copied (it references ${NODE_AUTH_TOKEN}, which is unset in the build sandbox
# and 401s). Instead, mount it as a BuildKit secret that carries scope+token:
#
#   docker build \
#     --secret id=npmrc,src=$HOME/.config/hollis/npmrc-with-token \
#     -t hollis-workouts-server .
#
# (TODO(deploy): SHA-pin the node:20-alpine base via Renovate/Dependabot.)
# ============================================================

# ---- Stage 1: builder ----
FROM node:20-alpine AS builder
WORKDIR /app

# Prisma's query engine needs openssl on alpine.
RUN apk add --no-cache openssl

COPY package.json package-lock.json ./
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm ci

# Generate the Prisma client (dummy URL satisfies generation; not used to connect).
COPY prisma/ ./prisma/
COPY prisma.config.ts ./
RUN DATABASE_URL=postgresql://dummy:dummy@localhost:5432/dummy npm run prisma:generate

# Compile TypeScript.
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Drop dev dependencies for a smaller runtime node_modules (keeps prisma/generated).
RUN npm prune --omit=dev

# ---- Stage 2: runner ----
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3002

RUN apk add --no-cache openssl && \
    addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 --ingroup nodejs workouts

# Built artifacts + pruned deps + generated Prisma client.
COPY --from=builder --chown=workouts:nodejs /app/dist ./dist
COPY --from=builder --chown=workouts:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=workouts:nodejs /app/prisma ./prisma
COPY --from=builder --chown=workouts:nodejs /app/package.json ./package.json

USER workouts

EXPOSE 3002

# Liveness probe — uses Node's global fetch (avoids busybox wget flag quirks).
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3002/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
