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
EXPOSE 9091
CMD ["node", "apps/worker/dist/main.js"]
