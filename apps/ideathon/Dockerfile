FROM node:22-alpine AS custos-build
WORKDIR /src/custos
COPY packages/custos-js/package*.json ./
RUN npm ci
COPY packages/custos-js/tsconfig.json packages/custos-js/vitest.config.ts ./
COPY packages/custos-js/src ./src
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production PORT=8080 CUSTOS_TELEMETRY=off
WORKDIR /app
COPY apps/ideathon/package*.json ./
COPY packages/custos-js/package.json /packages/custos-js/package.json
COPY --from=custos-build /src/custos/dist /packages/custos-js/dist
RUN npm install --omit=dev && npm cache clean --force
COPY apps/ideathon/src ./src
COPY apps/ideathon/public ./public
EXPOSE 8080
USER node
CMD ["node", "src/server.js"]
