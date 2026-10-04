FROM node:24-bookworm-slim AS build
WORKDIR /opt/octg
COPY package*.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
COPY examples ./examples
COPY scripts ./scripts
RUN npm run check && npm run build

FROM build AS test
RUN npm test
WORKDIR /app
RUN cp -a /opt/octg/. /app/
CMD ["npm", "test"]

FROM node:24-bookworm-slim AS runtime
ARG OPENCODE_VERSION=2.0.22
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @opencode/cli@${OPENCODE_VERSION} --no-audit --no-fund
WORKDIR /opt/octg
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --from=build /opt/octg/dist/src ./dist/src
COPY examples/opencode.jsonc ./examples/opencode.jsonc
COPY scripts ./scripts
RUN mkdir -p /workspace /home/node/.local/share /home/node/.config \
    && node --input-type=module -e 'import fs from "node:fs"; const config = JSON.parse(fs.readFileSync("examples/opencode.jsonc", "utf8")); config.plugins[0].package = "/opt/octg"; config.plugins[0].options.chat.host = "0.0.0.0"; fs.writeFileSync("/workspace/opencode.json", JSON.stringify(config, null, 2));' \
    && chown -R node:node /workspace /home/node/.local /home/node/.config
ENV HOME=/home/node
USER node
WORKDIR /workspace
EXPOSE 4096 8787
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD node /opt/octg/scripts/container-health.mjs
CMD ["opencode", "serve", "--service", "--hostname", "0.0.0.0", "--port", "4096"]
