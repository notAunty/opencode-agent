FROM node:24-bookworm-slim AS test
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
COPY examples ./examples
RUN npm run verify
CMD ["npm", "test"]
