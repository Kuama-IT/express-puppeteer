# Queue integration scenarios

These tests require an idle, dedicated service and a matching non-empty
`SECRET_KEY` in the test runner environment (the repository `.env` is loaded by
`node --import dotenv/config`). The service and test runner must use the same key.
The API origin defaults to `http://localhost:9000`; set `TEST_BASE_URL` only when
the service uses another origin.

Configure the running service with these exact queue settings:

```text
PDF_CONCURRENCY=1
PDF_MAX_PENDING=2
PDF_QUEUE_TIMEOUT_MS=30000
```

The queue-timeout case deliberately leaves one PDF active while a second waits
for the full 30-second queue deadline. It expects HTTP 503 with
`{"error":"PDF queue wait timed out"}`, then checks that another queued request
completes after the held job releases. Its test deadline is 60 seconds.

The waiting-cancellation case first fills both pending slots and confirms an
additional request receives 429. It then aborts one waiting client, retries
capacity probes until the released slot accepts a replacement, and checks that
the service returns valid PDFs for all accepted requests. The active-cancellation
case aborts a client while Chrome is blocked on the fixture image; both queued
PDFs must complete successfully while that image remains held. Its test deadline is
60 seconds per case.

Both cases use a temporary host-side HTTP server to hold an image request open
until queue state has been observed. For Docker Desktop, Chrome reaches the host
through `host.docker.internal`; use `TEST_ASSET_HOST=127.0.0.1` when the service
runs directly on the host. On native Linux Docker, make
`host.docker.internal` resolve to `host-gateway` or set `TEST_ASSET_HOST` to a
reachable host IP. `TEST_ASSET_HOST` is a hostname or IP, not a URL.

Do not run other tests or clients against the service during these cases. The
tests only call the existing HTTP service; they do not start, stop, or rebuild it.
