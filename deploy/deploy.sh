#!/usr/bin/env bash
#
# Auto-deploy for koinosai.com (Vultr VPS). Runs as the unprivileged `koinos`
# user on a 1-minute systemd timer. It pulls the production branch, reinstalls
# dependencies ONLY when they changed, and restarts the app. A push to the
# production branch is therefore live within ~1 minute with no manual step —
# replacing the git-integration auto-deploy we lost moving off Hostinger.
#
# Failure is safe: if the fetch fails (network/auth) `set -e` aborts before any
# reset, and the running app is left untouched on its current code.
#
# Install: see deploy/README.md. Lives on the box at /opt/koinos/deploy.sh.
set -euo pipefail

REPO=/opt/koinos/kai
BRANCH=claude/kai-production-website-fqx4pf

cd "$REPO"

# Only fetch the branch we deploy — cheap, and never advances anything else.
git fetch --quiet origin "$BRANCH"

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")

# Up to date: the common case. Exit silently so the journal isn't spammed.
[ "$LOCAL" = "$REMOTE" ] && exit 0

echo "deploy: $LOCAL -> $REMOTE"

# Reinstall dependencies only if the manifests moved between old and new HEAD —
# a code-only deploy then costs just a reset + a sub-second restart.
DEPS=$(git diff --name-only "$LOCAL" "$REMOTE" -- package.json package-lock.json || true)

# Make the working tree exactly match the branch (deploy target owns no local
# edits — all changes arrive through the branch).
git reset --hard "origin/$BRANCH"

if [ -n "$DEPS" ]; then
  echo "deploy: dependencies changed -> npm ci"
  npm ci
fi

# Only privileged action, whitelisted in /etc/sudoers.d/koinos-deploy.
sudo systemctl restart koinos

echo "deploy: live at $(git rev-parse --short HEAD)"
