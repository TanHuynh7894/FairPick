# Build from the repo root:  docker build -f dashboard/Dockerfile -t fairpick-dashboard .
# The page imports node/src, examples/ and docs/evidence/, so the context is the whole repo.
FROM node:22-alpine AS build
WORKDIR /app
COPY node/package.json node/package-lock.json node/
COPY dashboard/package.json dashboard/package-lock.json dashboard/
RUN cd node && npm ci --ignore-scripts && cd ../dashboard && npm ci --ignore-scripts
COPY node/src node/src
COPY examples examples
COPY docs/evidence docs/evidence
COPY dashboard dashboard

# VITE_ variables are baked into the build. Defaults are the live Fuji deployment (dashboard/.env.example).
ARG VITE_RPC_URL=https://api.avax-test.network/ext/bc/C/rpc
ARG VITE_ORACLE_ADDRESS=0xa4c1019b76EE5bEB9aFe641AAcf164b787b037Dd
ARG VITE_SAMPLER_ADDRESS=0x415eaC3a64111E68DB8136660CD7Ff06F9F4f654
ARG VITE_BEACON_ADDRESS=0x60198D44a183d313B5EAa432F85D184cab9F217C
ARG VITE_ICM_ADAPTER=0x1C2ee9B10369F8459F07A933590598C6076E11CE
ARG VITE_NODE_URLS=
ARG VITE_AUDITOR=
ENV VITE_RPC_URL=$VITE_RPC_URL VITE_ORACLE_ADDRESS=$VITE_ORACLE_ADDRESS VITE_SAMPLER_ADDRESS=$VITE_SAMPLER_ADDRESS \
    VITE_BEACON_ADDRESS=$VITE_BEACON_ADDRESS VITE_ICM_ADAPTER=$VITE_ICM_ADAPTER \
    VITE_NODE_URLS=$VITE_NODE_URLS VITE_AUDITOR=$VITE_AUDITOR
RUN cd dashboard && rm -f .env.local && npm run build

FROM nginx:1.27-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dashboard/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
