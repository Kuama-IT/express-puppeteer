#!/usr/bin/env bash
set -euo pipefail

# This helper replaces only the disposable CI container, never a local service.
if [[ "${GITHUB_ACTIONS:-}" != "true" ]]; then
    echo "This helper is restricted to GitHub Actions runners." >&2
    exit 1
fi

if docker container inspect express-puppeteer >/dev/null 2>&1; then
    docker logs express-puppeteer
    docker rm -f express-puppeteer
fi

docker run -d --name express-puppeteer --init --stop-timeout 60 \
    -p 127.0.0.1:9000:8080 \
    --add-host host.docker.internal:host-gateway \
    -e SECRET_KEY -e PDF_CONCURRENCY -e PDF_MAX_PENDING \
    -e PDF_QUEUE_TIMEOUT_MS -e PDF_JOB_TIMEOUT_MS \
    -e SHUTDOWN_DRAIN_TIMEOUT_MS=10000 -e SHUTDOWN_CLEANUP_TIMEOUT_MS=45000 \
    express-puppeteer:ci

# GET /api/ is intentionally not a PDF request. Its 404 confirms HTTP startup;
# the generation test separately verifies that Chrome can launch and render.
for attempt in {1..60}; do
    if [[ "$(curl --silent --output /dev/null --write-out '%{http_code}' \
        --max-time 2 http://localhost:9000/api/ || true)" == "404" ]]; then
        exit 0
    fi
    if [[ "$(docker inspect --format '{{.State.Running}}' express-puppeteer)" != "true" ]]; then
        break
    fi
    sleep 1
done

docker logs express-puppeteer
echo "PDF service did not become ready." >&2
exit 1
