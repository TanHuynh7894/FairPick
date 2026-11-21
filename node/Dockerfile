# Build from the repo root:  docker build -f node/Dockerfile -t fairpick-node .
FROM node:22-alpine
WORKDIR /app/node
COPY node/package.json node/package-lock.json ./
RUN npm ci --ignore-scripts && npm cache clean --force
COPY node/src src
ENV NODE_ENV=production ORACLE_HOST=0.0.0.0
USER node
CMD ["node", "--import", "tsx", "src/main.ts"]
