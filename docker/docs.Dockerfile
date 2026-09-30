FROM node:22.19.0-bookworm-slim AS build
WORKDIR /workspace
 
COPY . .
RUN npm ci
RUN npm --workspace @handstack/docs run build

FROM node:22.19.0-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=3002
ENV HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /workspace/apps/docs/.next/standalone ./
COPY --from=build /workspace/apps/docs/.next/static ./apps/docs/.next/static
COPY --from=build /workspace/docs/content ./docs/content
USER node
EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:3002/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "apps/docs/server.js"]
