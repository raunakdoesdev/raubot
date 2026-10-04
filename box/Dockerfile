FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl jq ripgrep && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
CMD ["sleep", "infinity"]
