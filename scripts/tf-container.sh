#!/usr/bin/env sh
# Run TaskForge (and all its agents) inside a container, working on the current
# Git repository. Usage: scripts/tf-container.sh [tf arguments]
#
# Only the current directory is mounted. Provider keys are passed by name, so
# their values never appear on the command line. Set the ones you use:
#   ANTHROPIC_API_KEY, OPENAI_API_KEY, TASKFORGE_OPENAI_API_KEY
set -eu

image="${TASKFORGE_IMAGE:-taskforge}"
repo="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "tf-container: run this from inside a Git repository." >&2
  exit 1
}

# Commits made by the agents need an identity; take yours from the host.
name="$(git config user.name || true)"
email="$(git config user.email || true)"

# Same uid/gid as the host, so files written to the mount are yours.
# A named volume keeps TaskForge state (and agent sign-ins) between runs.
exec docker run --rm -it \
  --user "$(id -u):$(id -g)" \
  -v "$repo:/workspace" \
  -v taskforge-home:/home/tf \
  -e GIT_AUTHOR_NAME="$name" -e GIT_COMMITTER_NAME="$name" \
  -e GIT_AUTHOR_EMAIL="$email" -e GIT_COMMITTER_EMAIL="$email" \
  -e ANTHROPIC_API_KEY -e OPENAI_API_KEY -e TASKFORGE_OPENAI_API_KEY \
  "$image" "$@"
