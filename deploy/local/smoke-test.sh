#!/usr/bin/env bash
# End-to-end smoke test against the local stack:
#   1. port-forward agent-master
#   2. health check
#   3. POST /runtime  -> schedule an Agent (Deployment + Service in agent-runtime)
#   4. wait for the Agent workload to appear and become ready
#   5. GET /agent/project/current -> verify proxy path to the Agent Service
#   6. DELETE /runtime -> verify cleanup
set -euo pipefail

USER_ID="${USER_ID:-smoke-user}"
LOCAL_PORT="${LOCAL_PORT:-3002}"
PF_PID=""

cleanup() {
  [ -n "$PF_PID" ] && kill "$PF_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[smoke] starting port-forward svc/agent-master ${LOCAL_PORT}:3000"
kubectl -n agent-master port-forward svc/agent-master "${LOCAL_PORT}:3000" >/dev/null 2>&1 &
PF_PID=$!
sleep 3

BASE="http://127.0.0.1:${LOCAL_PORT}"

echo "[smoke] GET /health"
curl -fsS "${BASE}/health"; echo

echo "[smoke] POST /runtime (x-user-id: ${USER_ID})"
curl -fsS -X POST "${BASE}/runtime" -H "x-user-id: ${USER_ID}"; echo

echo "[smoke] waiting for Agent workload in agent-runtime"
for i in $(seq 1 60); do
  ready=$(kubectl -n agent-runtime get deploy -l "userId=${USER_ID}" \
    -o jsonpath='{.items[0].status.readyReplicas}' 2>/dev/null || echo "")
  if [ "${ready:-0}" = "1" ]; then
    echo "[smoke] Agent ready"
    break
  fi
  sleep 3
done
kubectl -n agent-runtime get deploy,svc,pod -l "userId=${USER_ID}"

echo "[smoke] GET /agent/project/current (proxy)"
curl -fsS "${BASE}/agent/project/current" -H "x-user-id: ${USER_ID}"; echo

echo "[smoke] DELETE /runtime"
curl -fsS -X DELETE "${BASE}/runtime" -H "x-user-id: ${USER_ID}"; echo

echo "[smoke] done"
