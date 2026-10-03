FROM node:24-bookworm-slim AS test
WORKDIR /app
COPY package*.json ./
RUN npm install --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run verify
CMD ["npm", "test"]
