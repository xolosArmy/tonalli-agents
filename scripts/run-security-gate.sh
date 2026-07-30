#!/usr/bin/env bash
set -Eeuo pipefail

readonly REPOSITORY_URL="https://github.com/xolosArmy/tonalli-agents.git"
readonly REPOSITORY_NAME="tonalli-agents"
readonly BASE_IMAGE="node:24.14.0-bookworm"

if [[ $# -ne 1 ]] || [[ ! "$1" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "usage: $0 <40-character-commit-sha>" >&2
  exit 64
fi

readonly COMMIT_SHA="${1,,}"
readonly EVIDENCE_DIR="${SECURITY_GATE_EVIDENCE_DIR:-/tmp/tonalli-security-gate}"

if [[ -n "${CONTAINER_ENGINE:-}" ]]; then
  readonly ENGINE="${CONTAINER_ENGINE}"
elif command -v docker >/dev/null 2>&1; then
  readonly ENGINE="docker"
elif command -v podman >/dev/null 2>&1; then
  readonly ENGINE="podman"
else
  echo "Docker or Podman is required." >&2
  exit 69
fi

if [[ "${ENGINE}" != "docker" && "${ENGINE}" != "podman" ]]; then
  echo "CONTAINER_ENGINE must be docker or podman." >&2
  exit 64
fi

command -v git >/dev/null 2>&1
command -v sha256sum >/dev/null 2>&1
command -v "${ENGINE}" >/dev/null 2>&1

clone_root="$(mktemp -d)"
readonly clone_root
readonly clone_dir="${clone_root}/repository"
readonly image_tag="tonalli-agents-security-gate:${COMMIT_SHA:0:12}"

mkdir -p "${EVIDENCE_DIR}"
readonly log_file="${EVIDENCE_DIR}/${REPOSITORY_NAME}-security-gate-${COMMIT_SHA}.log"
readonly sha_file="${log_file}.sha256"

cleanup() {
  rm -rf -- "${clone_root}"
}
trap cleanup EXIT

run_gate() {
  echo "SECURITY REVIEW GATE 1"
  echo "repository=${REPOSITORY_URL}"
  echo "commit=${COMMIT_SHA}"
  echo "base_image=${BASE_IMAGE}"
  echo "container_engine=${ENGINE}"
  echo "dependency_installation=npm ci"
  echo "secrets=none"
  echo "persistent_volumes=none"
  echo
  echo "+ git clone --no-tags ${REPOSITORY_URL} ${clone_dir}"
  git clone --no-tags "${REPOSITORY_URL}" "${clone_dir}"
  echo "+ git -C ${clone_dir} checkout --detach ${COMMIT_SHA}"
  git -C "${clone_dir}" checkout --detach "${COMMIT_SHA}"
  echo "+ git -C ${clone_dir} rev-parse HEAD"
  test "$(git -C "${clone_dir}" rev-parse HEAD)" = "${COMMIT_SHA}"
  echo "${COMMIT_SHA}"
  echo "+ git -C ${clone_dir} status --porcelain=v1"
  test -z "$(git -C "${clone_dir}" status --porcelain=v1)"

  cd "${clone_dir}"

  if [[ "${ENGINE}" == "docker" ]]; then
    echo "+ docker build --no-cache --pull --progress=plain --file Dockerfile.security --tag ${image_tag} ."
    docker build \
      --no-cache \
      --pull \
      --progress=plain \
      --file Dockerfile.security \
      --tag "${image_tag}" \
      .
  else
    echo "+ podman build --no-cache --pull --file Dockerfile.security --tag ${image_tag} ."
    podman build \
      --no-cache \
      --pull \
      --file Dockerfile.security \
      --tag "${image_tag}" \
      .
  fi

  echo "+ ${ENGINE} run --rm --network=none ${image_tag}"
  "${ENGINE}" run --rm --network=none "${image_tag}"
  echo "SECURITY GATE 1 RESULT: PASS"
}

set +e
run_gate 2>&1 | tee "${log_file}"
gate_status="${PIPESTATUS[0]}"
set -e

sha256sum "${log_file}" > "${sha_file}"
echo "log=${log_file}"
echo "sha256_file=${sha_file}"
cat "${sha_file}"

exit "${gate_status}"
