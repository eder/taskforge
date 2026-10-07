# Runs the whole TaskForge control plane, and therefore every agent it starts
# in parallel, inside one container. Agents then see the mounted repository and
# the variables you pass in, not your real HOME (~/.ssh, ~/.aws, shell history).
# It does NOT restrict network access or protect the mounted repository.
#
#   docker build -t taskforge .
#   scripts/tf-container.sh            # from inside the project you want to work on
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates ripgrep \
 && rm -rf /var/lib/apt/lists/*

# Agent CLIs. Antigravity (`agy`) has no public npm package: add it in a derived image.
RUN npm install -g pnpm@12.4.2 @anthropic-ai/claude-code @openai/codex

WORKDIR /opt/taskforge
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build && npm link apps/cli

# /workspace is the repository to work on (mounted at run time). HOME is a
# throwaway directory, so state and sign-ins do not leak in from the host.
ENV TASKFORGE_ISOLATED=1 HOME=/home/tf
RUN mkdir -p /home/tf /workspace && chmod 1777 /home/tf /workspace
WORKDIR /workspace
USER node
ENTRYPOINT ["tf"]
