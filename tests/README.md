# Integration tests

## CI

The `CI` GitHub Actions workflow runs on pull requests, pushes to `main`, and
manual dispatch. It checks Prettier formatting, ESLint (including tests), the
application build and test types. A dedicated Ubuntu runner builds the Docker
image once with layer caching, then runs the default suite, browser-context
isolation, crash recovery, bounded stress, both shutdown variants, and job timeout.
Scenarios run sequentially; the service is recreated when its profile changes.
No production secrets or registry publishing are involved. Container logs are
printed before replacement and on completion/failure; cleanup runs even on failure.
This is short stress coverage, not a long-running soak test.

Use `npm run format:check` to check formatting or `npm run format` to apply it.
The two existing test scripts remain unchanged.

Use Node 26 on the host and a running Docker installation with Compose support.
Run all commands below from the repository root. Tests target an already running
local service. Only the explicitly enabled shutdown scenario stops its dedicated
container; the browser-recovery scenario kills Chrome inside that container.

## Prepare the environment

Install the test dependencies:

```sh
npm ci
```

If you do not already have a `.env`, copy `.env.example` to `.env` and set a
non-empty `SECRET_KEY`. Compose and the test runner both read this file, so they
must use the same key. Exported shell variables take precedence over `.env`.

Build and start the service:

```sh
docker compose up -d --build
```

On Apple Silicon (Mac ARM), build and run an `amd64` container for the Chrome
Linux binary used by this project:

```sh
DOCKER_DEFAULT_PLATFORM=linux/amd64 docker compose up -d --build --force-recreate
```

Use this same platform setting for subsequent rebuilds on Mac ARM. Execution is
emulated, so timings are not representative of a native production server.
The current Dockerfile uses the lockfile, and `.dockerignore` excludes host
`node_modules` and browser caches to avoid mixing host and container binaries.
Compose enables `init: true` to reap orphaned Chrome processes.

Follow startup logs:

```sh
docker compose logs -f express-puppeteer
```

Wait for `Server running on port 8080`, then press Ctrl+C to leave the log stream
(the container remains running). The host endpoint is `http://localhost:9000`.
Chrome starts lazily on the first PDF request, so this log confirms HTTP startup,
not successful browser startup.

## Run the generation test

Node runs the TypeScript tests directly. `tests/package.json` marks only the test
directory as ESM, leaving the application's CommonJS configuration unchanged.
Run the separate static type check without executing tests:

```sh
npm run typecheck:tests
```

The generation test sends a self-contained HTML fixture and checks HTTP headers,
PDF parsing, page count, and extracted text. It requires no external assets.

Set `SECRET_KEY` to match the service (the repository `.env` is loaded automatically).
The default service origin is `http://localhost:9000`, matching `compose.yaml`.

```sh
npm run test:integration -- tests/integration/generation.test.ts
```

For a different local port:

```sh
TEST_BASE_URL=http://localhost:8080 npm run test:integration -- tests/integration/generation.test.ts
```

A missing key, unreachable service, HTTP error, invalid PDF, or missing expected
text fails the test. The HTTP request has a 30-second timeout and the test has
a 45-second timeout.

## Run the queue-full test

This test requires an idle, dedicated service with one active slot, two pending
slots, and a 30-second queue timeout. Configure the running container explicitly
(changing only the test runner's environment does not change server settings):

```sh
DOCKER_DEFAULT_PLATFORM=linux/amd64 PDF_CONCURRENCY=1 PDF_MAX_PENDING=2 PDF_QUEUE_TIMEOUT_MS=30000 docker compose up -d
npm run test:integration -- tests/integration/queue-full.test.ts
```

Keep the content, protocol and job timeouts at the Compose defaults. Do not run
other tests or clients against this container concurrently.

The test opens a temporary HTTP server on the host on an automatically assigned
port. Chrome reaches it through `host.docker.internal` on Docker Desktop. Allow
incoming local connections to Node if prompted by the host firewall. For a service
running directly on the host, use `TEST_ASSET_HOST=127.0.0.1`; on native Linux Docker,
configure `host.docker.internal:host-gateway` or supply a host IP reachable by the
container. `TEST_ASSET_HOST` is a hostname/IP, not a URL.

An image response holds the first PDF open. Three further requests contend for
two waiting slots: one must return `429` before the image is released. The test
then releases the image and checks that all three accepted requests return PDFs.
It aborts its requests and closes its fixture server on completion or failure.
It does not start, stop or rebuild the application container.

## Other scenarios

There are only two npm scripts: `test:integration` runs tests and
`typecheck:tests` checks TypeScript without executing them. Select a file using
the same command shown above; test files run sequentially to avoid competing for
the same service.

`tests/browser-manager-races.test.ts` also runs by default. It exercises the real
browser-manager source with controlled Puppeteer promises (no Chrome or HTTP):
cancellation during acquisition/context creation, cold-launch timeout, lock-wait
cancellation, and shutdown during a late launch. Run it alone with:

```sh
npm run test:integration -- tests/browser-manager-races.test.ts
```

| File in `tests/integration/` | What it checks | Opt-in |
| --- | --- | --- |
| `generation.test.ts` | Readable PDF, page count and supplied text | No |
| `queue-full.test.ts` | 429 at capacity and completion of accepted jobs | No |
| `queue-timeout.test.ts` | Queue deadline returns 503, then recovery | No |
| `cancellation.test.ts` | Waiting and active client cancellation release capacity | No |
| `context-isolation.test.ts` | Browser manager isolates cookies/storage while sharing Chrome | `TEST_BROWSER_MANAGER=1` |
| `render-timeout.test.ts` | Job deadline returns 504, then recovery | `TEST_RENDER_TIMEOUT=1` |
| `browser-recovery.test.ts` | Chrome crash followed by successful generation | `TEST_BROWSER_RECOVERY=1` |
| `shutdown.test.ts` | Graceful container shutdown | `TEST_SHUTDOWN=1` |
| `stress.test.ts` | Bounded load, cancellations and recovery; optional process metrics | `TEST_STRESS=1` |

Run the default scenarios against the idle queue profile described above:

```sh
npm run test:integration
```

Leave all opt-in flags unset for this command. The browser-manager test runs
directly against the compiled application in a disposable Docker container;
see [its setup and command](lifecycle-scenarios.md). It does not use the API.
Timeout and destructive scenarios
have separate setup requirements and should be selected explicitly, one file at
a time. Restore the normal service configuration afterward.

See [queue scenarios](queue-scenarios.md), [lifecycle scenarios](lifecycle-scenarios.md)
and [bounded stress](stress-scenarios.md) for configuration and commands. Crash and
shutdown tests are for the dedicated local Compose container, never production.
The stress scenario is a short burst test, not proof of leak-free operation over
hours or days.

## Troubleshooting and cleanup

For an HTTP 500, inspect the service logs for the underlying error:

```sh
docker compose logs --tail=100 express-puppeteer
```

If Chrome cannot be found, rebuild using the current Dockerfile and, on Mac ARM,
the `DOCKER_DEFAULT_PLATFORM=linux/amd64` command above. Changes to the Dockerfile
or source require a rebuild; restarting an old container does not update it.

If the build reports that the browser folder exists but its executable is missing,
the browser installation is incomplete. The Dockerfile disables Puppeteer's download
during `npm ci`. A build-only script downloads the version pinned by Puppeteer,
extracts it with native `unzip`, and checks the executable with `chrome --version`.
If the problem persists with this Dockerfile, retry the build without cached layers:

```sh
DOCKER_DEFAULT_PLATFORM=linux/amd64 docker compose build --no-cache
DOCKER_DEFAULT_PLATFORM=linux/amd64 docker compose up -d --force-recreate
```

If a fresh build still fails, inspect the download/extraction error rather than
reusing the incomplete browser directory.

When finished:

```sh
docker compose down
```
