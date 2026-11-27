#!/usr/bin/env bash
set -euo pipefail
# Upstream v0.1.13. Keep contracts, shared code, app and runtime at one immutable revision.
pin=bc0f04da94f64b5e487c598761a43b4cf06b2ac9
git cat-file -e "$pin^{commit}" 2>/dev/null || git fetch --depth=1 origin "$pin"
(cd apps/server && vp pack)
stock=$(mktemp -d)
trap 'rm -rf -- "$stock"' EXIT
git archive "$pin" -- . ':!.repos' | tar -x -C "$stock"
(cd "$stock" && vp install --frozen-lockfile --ignore-scripts)
cp scripts/banneret/mobile/client.fixture.mjs "$stock/apps/mobile/src/features/connection/banneret.test.ts"
node scripts/banneret/mobile/fixture.mjs "$stock"
