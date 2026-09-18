# syntax=docker/dockerfile:1.9.0
FROM node:22-bookworm-slim AS base

WORKDIR /app
ENV NODE_ENV=production \
    WRANGLER_SEND_METRICS=false

FROM base AS builder

# Dev dependencies are needed for the build (vinext, vite, tailwind).
ENV NODE_ENV=development
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .

# Browser RPC lists are inlined into the client bundle at build time.
ARG NEXT_PUBLIC_MAINNET_RPC_URLS=
ARG NEXT_PUBLIC_HOODI_RPC_URLS=
RUN npm run build

FROM base AS production

# vinext start serves the built app with Node and resolves a few externals
# from node_modules, so the production image keeps the full dependency tree.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json

ENV PORT=3000
EXPOSE $PORT

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
    CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "vinext", "start"]
