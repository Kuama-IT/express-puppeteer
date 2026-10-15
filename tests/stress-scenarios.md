# Bounded stress scenario

`tests/integration/stress.test.ts` is opt-in. It skips unless `TEST_STRESS=1` is
set, and it requires a dedicated local service with `SECRET_KEY` configured. It
uses `TEST_BASE_URL` (default `http://localhost:9000`) and refuses a non-local
hostname.

Run the test against a service you are comfortable loading:

```sh
TEST_STRESS=1 TEST_STRESS_ROUNDS=2 TEST_STRESS_CONCURRENCY=4 \
SECRET_KEY=... TEST_BASE_URL=http://localhost:9000 \
npm run test:integration -- tests/integration/stress.test.ts
```

The rounds setting is limited to 1–5 and concurrency to 2–8. The test first
warms the browser, then each batch sends one intentionally early-aborted request
and otherwise requests PDFs. A successful response must be HTTP 200, declare
`application/pdf`, and begin with `%PDF-`.
HTTP 429 and 503 are recorded as overload outcomes; other statuses fail the test.
After all batches, a regular request must produce a valid PDF. Transient 429/503
recovery responses are retried up to three times while aborted work drains.
The test logs each batch's duration, per-request latency and outcome counts, plus
an overall summary.

Optionally set `TEST_CONTAINER` to the exact local container name or ID to sample
read-only `docker stats` PID/memory data and the process list before and after the
load. The test uses only `docker stats --no-stream` and `docker exec ... ps`; it
does not start, stop, kill, or alter the container. PID and memory figures are
reported for diagnosis because Docker's PID count includes threads and can vary
normally. The test waits up to five seconds for the zombie count to return to its
post-warmup baseline, then fails if it has not. Without this setting, no process
metrics are collected.

This scenario checks behavior under a short, capped burst and whether the service
answers a request afterward. HTTP outcomes, process counts, and a single memory
sample cannot prove that there are no resource leaks. A leak assessment needs
repeated controlled runs, a quiet baseline, and longer-term measurements of the
relevant process and browser resources.
