#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Gate 2 Cross-Repo Contract Harness Reproducibility Script
# ==============================================================================
# This script provisions an isolated, clean temporary directory, checks out
# tonalli-agents and RMZWallet at their exact audit commit SHAs, installs
# dependencies independently, and executes the cross-repo contract harness.
# ==============================================================================

if [ -d "/home/xolosarmy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin" ]; then
  export PATH="/home/xolosarmy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_ORIGIN="${AGENTS_SRC:-$(cd "$SCRIPT_DIR/.." && pwd)}"
WALLET_ORIGIN="${WALLET_SRC:-$(cd "$SCRIPT_DIR/../../RMZWallet" && pwd)}"

# Fixed exact commit SHAs (can be overridden via environment)
WALLET_REV="${WALLET_REV:-6ce09d3679fb01286d8ef77df3fe1fdc08244858}"
AGENTS_REV="${AGENTS_REV:-$(git -C "$AGENTS_ORIGIN" rev-parse HEAD)}"

TEMP_HARNESS_DIR="$(mktemp -d /tmp/gate2-crossrepo-harness-XXXXXX)"
echo "=== [Gate 2 Cross-Repo] Provisioning isolated test harness in $TEMP_HARNESS_DIR ==="

cleanup() {
  if [ -d "$TEMP_HARNESS_DIR" ]; then
    echo "=== [Gate 2 Cross-Repo] Cleaning up $TEMP_HARNESS_DIR ==="
    rm -rf "$TEMP_HARNESS_DIR"
  fi
}
trap cleanup EXIT

echo "--> Cloning and checking out tonalli-agents @ $AGENTS_REV"
git clone --quiet "$AGENTS_ORIGIN" "$TEMP_HARNESS_DIR/tonalli-agents"
(
  cd "$TEMP_HARNESS_DIR/tonalli-agents"
  git checkout --quiet "$AGENTS_REV"
)

echo "--> Cloning and checking out RMZWallet @ $WALLET_REV"
git clone --quiet "$WALLET_ORIGIN" "$TEMP_HARNESS_DIR/RMZWallet"
(
  cd "$TEMP_HARNESS_DIR/RMZWallet"
  git checkout --quiet "$WALLET_REV"
)

echo "--> Installing dependencies for RMZWallet"
(
  cd "$TEMP_HARNESS_DIR/RMZWallet"
  npm ci --silent --prefer-offline 2>/dev/null || npm install --silent
)

echo "--> Installing dependencies for tonalli-agents"
(
  cd "$TEMP_HARNESS_DIR/tonalli-agents"
  npm ci --silent --prefer-offline 2>/dev/null || npm install --silent
  (cd tonalli-agent-sdk && (npm ci --silent --prefer-offline 2>/dev/null || npm install --silent))
  (cd tonalli-agent-sdk && npm run build)
)

echo "--> Executing Gate 2 Cross-Repo Contract Harness..."
(
  cd "$TEMP_HARNESS_DIR/tonalli-agents"
  export RMZ_WALLET_ROOT="$TEMP_HARNESS_DIR/RMZWallet"
  node --import tsx --test test/crossrepo/gate2-crossrepo-contract.test.ts
)

echo "=== [Gate 2 Cross-Repo] Reproduction verification SUCCESSFUL ==="
