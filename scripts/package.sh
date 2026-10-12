#!/usr/bin/env bash
# Build dist/lazarus-revived-<version>.zip containing only what Chrome needs.
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(node -p "require('./manifest.json').version")
out="dist/lazarus-revived-${version}.zip"
mkdir -p dist
rm -f "$out"
zip -r -q "$out" manifest.json background.js content.js lib popup options icons LICENSE README.md -x '*.DS_Store'
echo "$out"
