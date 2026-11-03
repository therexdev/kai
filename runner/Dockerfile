FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends protobuf-compiler && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/toolchain
COPY templates/builder/contract/package.json templates/builder/contract/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY runner/harness.cjs runner/pect.cjs runner/asconfig.json /opt/toolchain/
ENV NODE_ENV=production NODE_PATH=/opt/toolchain/node_modules
USER 1000:1000
WORKDIR /workspace
ENTRYPOINT ["timeout", "--kill-after=5s", "125s", "node", "/opt/toolchain/harness.cjs"]
