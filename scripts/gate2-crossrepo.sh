#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Gate 2 Cross-Repo Contract Harness Reproducibility Script
# ==============================================================================
# Verifies cross-repo contract interoperability between tonalli-agents and RMZWallet
# using strict remote checkouts, exact commit SHAs, and clean lockfile installs.
# Classification: "Cross-Repo Contract Harness" (invokes approveHandle direct boundary,
# not the human interactive React modal).
# ==============================================================================

if [ -d "/home/xolosarmy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin" ]; then
  export PATH="/home/xolosarmy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
fi

# Repositories (defaults to canonical GitHub remotes, or configurable via env / args)
AGENTS_REPO_DEFAULT="https://github.com/xolosArmy/tonalli-agents.git"
WALLET_REPO_DEFAULT="https://github.com/xolosArmy/RMZWallet.git"

AGENTS_REPO="${AGENTS_REPO:-${3:-$AGENTS_REPO_DEFAULT}}"
WALLET_REPO="${WALLET_REPO:-${4:-$WALLET_REPO_DEFAULT}}"

# Required exact 40-character hex commit SHAs
AGENTS_SHA="${AGENTS_SHA:-${1:-}}"
WALLET_SHA="${WALLET_SHA:-${2:-}}"

if [ -z "$AGENTS_SHA" ] || [ -z "$WALLET_SHA" ]; then
  echo "Usage: $0 <AGENTS_SHA> <WALLET_SHA> [AGENTS_REPO_URL] [WALLET_REPO_URL]" >&2
  echo "Or set AGENTS_SHA and WALLET_SHA environment variables." >&2
  exit 1
fi

# Strict 40-character hex SHA validation
HEX_REGEX='^[0-9a-fA-F]{40}$'
if [[ ! "$AGENTS_SHA" =~ $HEX_REGEX ]]; then
  echo "ERROR: AGENTS_SHA must be an exact 40-character hexadecimal commit SHA. Got: '$AGENTS_SHA'" >&2
  exit 1
fi

if [[ ! "$WALLET_SHA" =~ $HEX_REGEX ]]; then
  echo "ERROR: WALLET_SHA must be an exact 40-character hexadecimal commit SHA. Got: '$WALLET_SHA'" >&2
  exit 1
fi

# NODE_AUTH_TOKEN validation before installing RMZWallet (required for @xolosarmy GitHub packages)
if [ -z "${NODE_AUTH_TOKEN:-}" ]; then
  if command -v gh >/dev/null 2>&1; then
    NODE_AUTH_TOKEN="$(gh auth token 2>/dev/null || true)"
    export NODE_AUTH_TOKEN
  fi
fi

if [ -z "${NODE_AUTH_TOKEN:-}" ]; then
  echo "ERROR: NODE_AUTH_TOKEN is required for RMZWallet npm package authentication but is not available in environment." >&2
  exit 1
fi
echo "✓ NODE_AUTH_TOKEN is available in environment (length: ${#NODE_AUTH_TOKEN})"

TEMP_HARNESS_DIR="$(mktemp -d /tmp/gate2-crossrepo-harness-XXXXXX)"
echo "=== [Gate 2 Cross-Repo Contract Harness] Provisioning isolated workspace: $TEMP_HARNESS_DIR ==="

cleanup() {
  if [ -d "$TEMP_HARNESS_DIR" ]; then
    echo "=== [Gate 2 Cross-Repo Contract Harness] Cleaning up $TEMP_HARNESS_DIR ==="
    rm -rf "$TEMP_HARNESS_DIR"
  fi
}
trap cleanup EXIT

echo "--> Cloning tonalli-agents from $AGENTS_REPO"
git clone "$AGENTS_REPO" "$TEMP_HARNESS_DIR/tonalli-agents"
(
  cd "$TEMP_HARNESS_DIR/tonalli-agents"
  git checkout "$AGENTS_SHA"
  ACTUAL_AGENTS_HEAD="$(git rev-parse HEAD)"
  echo "tonalli-agents checked-out HEAD: $ACTUAL_AGENTS_HEAD"
  if [ "$ACTUAL_AGENTS_HEAD" != "$AGENTS_SHA" ]; then
    echo "ERROR: tonalli-agents HEAD mismatch. Expected $AGENTS_SHA, got $ACTUAL_AGENTS_HEAD" >&2
    exit 1
  fi
)

echo "--> Cloning RMZWallet from $WALLET_REPO"
git clone "$WALLET_REPO" "$TEMP_HARNESS_DIR/RMZWallet"
(
  cd "$TEMP_HARNESS_DIR/RMZWallet"
  git checkout "$WALLET_SHA"
  ACTUAL_WALLET_HEAD="$(git rev-parse HEAD)"
  echo "RMZWallet checked-out HEAD: $ACTUAL_WALLET_HEAD"
  if [ "$ACTUAL_WALLET_HEAD" != "$WALLET_SHA" ]; then
    echo "ERROR: RMZWallet HEAD mismatch. Expected $WALLET_SHA, got $ACTUAL_WALLET_HEAD" >&2
    exit 1
  fi
)

echo "--> Installing dependencies for RMZWallet via npm ci (no silent, no fallback)"
(
  cd "$TEMP_HARNESS_DIR/RMZWallet"
  npm ci
  echo "--> Compiling RMZWallet from lockfile"
  npm run build
)

echo "--> Installing dependencies for tonalli-agents via npm ci (no silent, no fallback)"
(
  cd "$TEMP_HARNESS_DIR/tonalli-agents"
  npm ci
  echo "--> Compiling tonalli-agent-sdk from lockfile"
  (
    cd tonalli-agent-sdk
    npm ci
    npm run build
  )
)

echo "--> Executing Gate 2 Cross-Repo Contract Harness..."
(
  cd "$TEMP_HARNESS_DIR/tonalli-agents"
  export RMZ_WALLET_ROOT="$TEMP_HARNESS_DIR/RMZWallet"
  node --import tsx --test test/crossrepo/gate2-crossrepo-contract.test.ts
)

echo "=== [Gate 2 Cross-Repo Contract Harness] Execution completed successfully ==="
