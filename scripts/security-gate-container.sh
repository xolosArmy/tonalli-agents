#!/usr/bin/env bash
set -Eeuo pipefail

readonly ACTUAL_COMMIT="$(git -c safe.directory=/workspace rev-parse HEAD)"

echo "container_repository=tonalli-agents"
echo "container_commit=${ACTUAL_COMMIT}"
echo "container_base_image=node:24.14.0-bookworm"
echo "node_version=$(node --version)"
echo "npm_version=$(npm --version)"

echo "+ npm test"
npm test

echo "+ npm --prefix tonalli-agent-sdk run check"
npm --prefix tonalli-agent-sdk run check

echo "+ npm --prefix tonalli-agent-sdk run build"
npm --prefix tonalli-agent-sdk run build

echo "+ npm --prefix tonalli-cli run check"
npm --prefix tonalli-cli run check

echo "+ npm --prefix tonalli-cli run build"
npm --prefix tonalli-cli run build

echo "+ node scripts/scan-forbidden-patterns.mjs"
node scripts/scan-forbidden-patterns.mjs

echo "+ git diff --exit-code"
git -c safe.directory=/workspace diff --exit-code
