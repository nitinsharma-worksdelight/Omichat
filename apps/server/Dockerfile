# Build from the repository root:  docker build -f apps/server/Dockerfile -t omni-server .
# One image, two processes: `node dist/main.js` (API) and `node dist/worker.js` (queue workers).
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/widget/package.json apps/widget/
RUN npm ci -w @omni/server -w @omni/widget --include-workspace-root
COPY apps/server apps/server
COPY apps/widget apps/widget
RUN npm run build -w @omni/server && npm run build -w @omni/widget

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
RUN npm ci -w @omni/server --omit=dev

FROM node:22-slim
ENV NODE_ENV=production \
    MIGRATIONS_DIR=/app/apps/server/drizzle \
    WIDGET_BUNDLE_PATH=/app/apps/widget/dist/widget.js
WORKDIR /app/apps/server
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=build /app/apps/server/dist ./dist
COPY --from=build /app/apps/server/drizzle ./drizzle
COPY --from=build /app/apps/server/package.json ./package.json
COPY --from=build /app/apps/widget/dist /app/apps/widget/dist
USER node
EXPOSE 4000
CMD ["node", "dist/main.js"]
