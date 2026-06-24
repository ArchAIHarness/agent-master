#!/usr/bin/env bash
# Build the agent-master image into the local docker-desktop daemon.
# docker-desktop's Kubernetes shares the same image store, so no registry/push
# is needed. The Deployment uses imagePullPolicy: IfNotPresent + tag :local.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE="${AGENT_MASTER_IMAGE:-agent-master:local}"

echo "[build] verifying agent-master before image build"
cd "$REPO_ROOT"
bun install --frozen-lockfile
bun test
bun run typecheck

echo "[build] docker build -> ${IMAGE}"
docker build -t "${IMAGE}" "$REPO_ROOT"

echo "[build] done: ${IMAGE}"
docker images "${IMAGE%%:*}" | head -5
