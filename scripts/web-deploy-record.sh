#!/bin/sh
# Prints one JSON line tying a Docker deployment to its source: the commit, whether the tree was clean, the web and
# worker image IDs and labels, the running container's image, /healthz, and the SHA-256 of the served and built app.js.
# Usage: scripts/web-deploy-record.sh [base-url] >> deploys.jsonl
set -eu
base=${1:-http://127.0.0.1:8787}
web=${THEOREMOS_WEB_IMAGE:-theorem-os-web:local} worker=${THEOREMOS_WEB_WORKER_IMAGE:-theorem-os-worker:local}
container=${THEOREMOS_WEB_CONTAINER:-theorem-os-web-1}
commit=$(git rev-parse HEAD)
if [ -z "$(git status --porcelain --untracked-files=no)" ]; then clean=true; else clean=false; fi
label() { docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$1"; }
image() { docker image inspect --format '{{.Id}}' "$1"; }
served=$(curl --fail --silent "$base/app.js" | sha256sum | cut -d' ' -f1)
built=$(docker exec "$container" sha256sum /opt/theorem-os/out/web/app.js | cut -d' ' -f1)
printf '{"at":"%s","commit":"%s","clean":%s,"web":{"image":"%s","id":"%s","revision":"%s","running":"%s"},' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$commit" "$clean" "$web" "$(image "$web")" "$(label "$web")" \
  "$(docker inspect --format '{{.Image}}' "$container")"
printf '"worker":{"image":"%s","id":"%s","revision":"%s"},"healthz":%s,"appJs":{"served":"%s","built":"%s"}}\n' \
  "$worker" "$(image "$worker")" "$(label "$worker")" "$(curl --fail --silent "$base/healthz")" "$served" "$built"
