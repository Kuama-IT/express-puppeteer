# Lifecycle integration scenarios

Except for context isolation, these scenarios call an already running service.
The tests do not build, create, or start a container. Run Node 26 from the repository root after installing the
test dependencies and setting `SECRET_KEY` in the host environment or `.env`.
The service and test runner must use the same key. The default endpoint is
`http://localhost:9000`; `TEST_BASE_URL` may override it. Chrome reaches fixture
servers through `host.docker.internal` by default; set `TEST_ASSET_HOST` to a
reachable host address when needed.

The timeout test requires a service started with a short job timeout. For the
Compose service, run:

```sh
PDF_JOB_TIMEOUT_MS=15000 docker compose up -d
TEST_RENDER_TIMEOUT=1 npm run test:integration -- tests/integration/render-timeout.test.ts
```

The fixture holds an image response open while Chrome waits for image loading.
With the 15-second job deadline, the test expects HTTP 504 with `PDF job timed
out`, followed by a successful PDF request on the same service. The 75-second
test allowance accommodates slower emulated Chrome. The test is skipped unless
`TEST_RENDER_TIMEOUT=1`. Use a dedicated idle service and do not run other PDF
requests concurrently.

The context-isolation test calls the compiled browser manager directly, not the
HTTP API. It starts its own Chrome and loopback fixture server, navigates the
top-level page to an HTTP origin, writes and reads cookies and local storage,
then verifies that a second operation uses the same browser with an empty
context. It also checks that the first context was closed. Cleanup closes its
browser and fixture server without touching the API service's browser.

Run it in a disposable container with the existing Chrome installation.
Rebuild first to include the updated test and current application code:

```sh
DOCKER_DEFAULT_PLATFORM=linux/amd64 docker compose build
DOCKER_DEFAULT_PLATFORM=linux/amd64 docker compose run --rm --no-deps -e TEST_BROWSER_MANAGER=1 express-puppeteer npm run test:integration -- tests/integration/context-isolation.test.ts
```

The platform setting is needed on Mac ARM. Compose supplies `SECRET_KEY`, required
by application configuration even though this test does not call the API.
The test skips unless `TEST_BROWSER_MANAGER=1`. For host execution, first run
`npm run build` and install Puppeteer's matching local Chrome, then use
`TEST_BROWSER_MANAGER=1 npm run test:integration -- tests/integration/context-isolation.test.ts`.
This replaces the iframe fixture: browser policy can deny storage to an iframe
inside `about:blank` before context isolation is even exercised.

Browser crash and shutdown tests are destructive and are skipped by default.
They require the explicitly named dedicated Compose container, a loopback HTTP
endpoint, and must not run against any shared or production service. Run these
one at a time, with no concurrent clients:

```sh
TEST_CONTAINER=express-puppeteer TEST_BROWSER_RECOVERY=1 npm run test:integration -- tests/integration/browser-recovery.test.ts
```

This first warms Chrome, identifies the single Chrome root process inside the
named container, kills only that process, then verifies a later PDF request can
be served by a newly launched browser. It never signals a host process.

The shutdown test stops the named container and intentionally leaves it stopped:

```sh
TEST_CONTAINER=express-puppeteer TEST_SHUTDOWN=1 npm run test:integration -- tests/integration/shutdown.test.ts
```

It holds an active PDF job open, asks Docker to stop the service with a 60-second
grace period, waits until the server stops accepting new connections, then
releases the job so shutdown can drain cleanly. It checks that the target
container is `exited` with exit code 0 and no OOM kill. Restart it manually
when ready:

```sh
docker start express-puppeteer
```

After restarting, run the permanently blocked variant separately:

```sh
TEST_CONTAINER=express-puppeteer TEST_SHUTDOWN=1 TEST_SHUTDOWN_BLOCKED=1 npm run test:integration -- tests/integration/shutdown.test.ts
```

This leaves the image blocked until teardown. With the default shutdown settings,
the service must cancel the job after its 10-second drain deadline, return 503,
close Chrome, and exit with code 0 before Docker's 60-second grace expires.
Keep the PDF job timeout greater than the drain deadline. Both variants leave
the container stopped. Rebuild/recreate the service after changing application
code or shutdown configuration; an old image does not contain the fixes.

Each destructive test has its own opt-in flag in addition to
`TEST_CONTAINER=express-puppeteer`. They reject a non-loopback `TEST_BASE_URL`,
verify Docker resolves the exact container name, and check that the endpoint's
published port belongs to that running container. Set these flags only when
`express-puppeteer` is a dedicated test container that may be disrupted.
