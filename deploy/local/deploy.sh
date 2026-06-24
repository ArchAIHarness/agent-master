#!/usr/bin/env bash
# Deploy the full local stack onto docker-desktop Kubernetes.
# Idempotent: safe to re-run. Requires the agent-master:local image to exist
# (run deploy/local/build-image.sh first).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OVERLAY="$REPO_ROOT/deploy/k8s/local"
CONTEXT="${KUBE_CONTEXT:-docker-desktop}"

echo "[deploy] context: ${CONTEXT}"
kubectl config use-context "${CONTEXT}" >/dev/null

echo "[deploy] applying local overlay"
kubectl apply -k "$OVERLAY"

echo "[deploy] waiting for NFS server"
kubectl -n agent-runtime rollout status deploy/nfs-server --timeout=120s

echo "[deploy] waiting for Redis"
kubectl -n agent-runtime rollout status deploy/redis --timeout=120s

echo "[deploy] waiting for agent-master"
kubectl -n agent-master rollout status deploy/agent-master --timeout=180s

echo "[deploy] PVC status"
kubectl -n agent-master get pvc agent-master-nas
kubectl -n agent-runtime get pvc agent-runtime-nas

echo "[deploy] done"
