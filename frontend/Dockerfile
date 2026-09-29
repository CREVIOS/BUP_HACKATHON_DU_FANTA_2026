# Next.js operator UI — built to a standalone Node server (output: "standalone").
# Multi-stage: install deps, build, then run a minimal image as non-root.
# pnpm is installed via npm (pinned to the lockfile's major, v9) rather than
# corepack: the corepack path tried to fetch an arch-specific pnpm 12 binary,
# which is both wrong for a v9 lockfile and unreliable over emulation.
FROM node:22-alpine AS base
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm install -g pnpm@9

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Cache the pnpm content-addressable store so unchanged deps aren't re-fetched.
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
RUN addgroup -g 1001 -S nodejs && adduser -S -u 1001 -G nodejs nextjs
# The standalone bundle ships its own trimmed node_modules + server.js;
# static assets and public/ must be copied alongside it.
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
