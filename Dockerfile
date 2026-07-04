############################
# Docker build environment #
############################

FROM node:24.16.0-bookworm-slim AS build

# Upgrade all packages and install dependencies
RUN apt-get update \
    && apt-get upgrade -y
RUN DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        python3 \
        build-essential \
        cmake \
        curl \
        ca-certificates \
    && apt clean && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

WORKDIR /build

COPY . .

# Build Public Pool using NPM
RUN npm i && npm run build

############################
# Docker final environment #
############################

FROM node:24.16.0-bookworm-slim

# Expose Stratum and API ports. 8332 (Elektron RPC) is intentionally NOT
# exposed here: this container is an RPC *client* to your Elektron node
# (ELEKTRON_RPC_URL in .env), not an RPC server, so nothing inside this
# image ever listens on that port.
EXPOSE 3333 3334

WORKDIR /elektron-pool

# Copy built binaries into the final image
COPY --from=build /build .
#COPY .env.example .env

CMD ["/usr/local/bin/node", "dist/main"]
