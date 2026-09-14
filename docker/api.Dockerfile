FROM node:22.19.0-bookworm-slim AS build
WORKDIR /workspace
COPY . .
RUN npm ci
RUN npm run build

FROM node:22.19.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /workspace
COPY --from=build /workspace /workspace
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:3001/health/live').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "apps/api/dist/main.js"]
