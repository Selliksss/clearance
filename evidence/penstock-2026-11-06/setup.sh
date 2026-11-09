#!/usr/bin/env sh
# Puts Penstock at the pinned commit next to the Clearance checkout (or at $PENSTOCK_DIR) and installs it.
# Needs Node 22.13+ and pnpm 9 (corepack enable). Nothing here touches a network other than GitHub and the npm registry.
set -eu
DIR="${PENSTOCK_DIR:-$HOME/Projects/penstock}"
COMMIT=3e7a330
if [ ! -d "$DIR/.git" ]; then git clone -q https://github.com/ace-coderr/penstock "$DIR"; fi
cd "$DIR" && git fetch -q && git checkout -q "$COMMIT" && pnpm install --frozen-lockfile
echo "penstock $(git rev-parse --short HEAD) at $DIR; run with: PENSTOCK_DIR=$DIR $DIR/node_modules/.bin/tsx evidence/penstock-2026-11-06/run.mts ..."
