#!/bin/bash
# Clone raubot's own code into the box once per container lifetime.
set -e
cd /workspace
[ -d raubot/.git ] || git clone -q "https://x-access-token:${GITHUB_TOKEN}@github.com/raunakdoesdev/raubot.git" raubot
cd raubot
git config user.name raubot && git config user.email raubot@reducto.ai
[ -d node_modules ] || npm ci --silent --no-audit --no-fund
