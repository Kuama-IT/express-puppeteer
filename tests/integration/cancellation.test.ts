import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { _assertPdf, _generate, _holdImage, _track } from "../support/http.ts";

// Requires an idle service with concurrency=1, maxPending=2, queueTimeoutMs=30000.
test(
    "removes an aborted waiting request from the queue",
    {
        timeout: 60000,
    },
    async (t) => {
        const secretKey = process.env.SECRET_KEY;
        assert.ok(
            secretKey,
            "Set SECRET_KEY to the API key used by the running service.",
        );

        const endpoint = new URL(
            "/api/",
            process.env.TEST_BASE_URL ?? "http://localhost:9000",
        );
        const cleanup = new AbortController();
        const signal = AbortSignal.any([
            cleanup.signal,
            AbortSignal.timeout(50000),
        ]);
        const requests: Promise<Response>[] = [];
        const fixture = await _holdImage();

        t.after(async () => {
            cleanup.abort();
            await fixture.close();
            await Promise.allSettled(requests);
        });

        const active = _track(
            requests,
            _generate(
                endpoint,
                secretKey,
                `<h1>Waiting cancellation blocker</h1><img src="${fixture.imageUrl.href}">`,
                signal,
            ),
        );
        await Promise.race([
            fixture.requested,
            active.then((response) => {
                throw new Error(
                    `Expected held image, but active request returned HTTP ${response.status}.`,
                );
            }),
            once(AbortSignal.timeout(20000), "abort").then(() => {
                throw new Error(
                    "Chrome did not request the held fixture image.",
                );
            }),
        ]);

        const waitingCancellations = Array.from(
            { length: 3 },
            () => new AbortController(),
        );
        const waiting = waitingCancellations.map((controller, index) => {
            const request = _track(
                requests,
                _generate(
                    endpoint,
                    secretKey,
                    `<h1>Waiting candidate ${index}</h1>`,
                    AbortSignal.any([controller.signal, signal]),
                ),
            );
            return request.then(
                (response) => ({ index, response }),
                (error: unknown) => ({ index, error }),
            );
        });
        const overflowResult = await Promise.race(waiting);
        assert.ok(
            "response" in overflowResult,
            "A capacity probe should return an HTTP response.",
        );
        assert.equal(overflowResult.response.status, 429);
        assert.deepEqual(await overflowResult.response.json(), {
            error: "PDF queue is full",
        });

        const acceptedWaiting = waitingCancellations
            .map((_, index) => index)
            .filter((index) => index !== overflowResult.index);
        const cancelledWaitingIndex = acceptedWaiting[0];
        const retainedWaitingIndex = acceptedWaiting[1];
        waitingCancellations[cancelledWaitingIndex].abort();
        const waitingResult = await waiting[cancelledWaitingIndex];
        assert.ok(
            "error" in waitingResult,
            "Aborting an accepted waiting request should reject its fetch.",
        );
        assert.equal(
            waitingResult.error instanceof Error
                ? waitingResult.error.name
                : "",
            "AbortError",
        );

        let replacement: Promise<Response> | undefined;
        for (let attempt = 0; attempt < 30 && !replacement; attempt++) {
            const candidate = _track(
                requests,
                _generate(
                    endpoint,
                    secretKey,
                    `<h1>Replacement waiter ${attempt}</h1>`,
                    signal,
                ),
            );
            const result = await Promise.race([
                candidate.then((response) => ({ response })),
                once(AbortSignal.timeout(500), "abort").then(() => ({
                    accepted: true as const,
                })),
            ]);
            if ("accepted" in result) {
                replacement = candidate;
            } else if (result.response.status === 429) {
                await result.response.json();
                continue;
            } else {
                assert.fail(
                    `Expected a queue-full response or a waiting request, received HTTP ${result.response.status}.`,
                );
            }
        }
        assert.ok(
            replacement,
            "A request should occupy the slot released by the cancelled waiter within 15 seconds.",
        );

        const secondOverflow = await _generate(
            endpoint,
            secretKey,
            "<h1>Replacement capacity probe</h1>",
            signal,
        );
        requests.push(Promise.resolve(secondOverflow));
        assert.equal(
            secondOverflow.status,
            429,
            "The accepted replacement should fill the freed pending slot.",
        );
        assert.deepEqual(await secondOverflow.json(), {
            error: "PDF queue is full",
        });

        fixture.release();
        const [activeResponse, queuedResponse, replacementResponse] =
            await Promise.all([
                active,
                waiting[retainedWaitingIndex].then((result) => {
                    assert.ok("response" in result);
                    return result.response;
                }),
                replacement,
            ]);
        await _assertPdf(activeResponse);
        await _assertPdf(queuedResponse);
        await _assertPdf(replacementResponse);
    },
);

test(
    "an aborted active client releases capacity while its render is blocked",
    {
        timeout: 60000,
    },
    async (t) => {
        const secretKey = process.env.SECRET_KEY;
        assert.ok(
            secretKey,
            "Set SECRET_KEY to the API key used by the running service.",
        );

        const endpoint = new URL(
            "/api/",
            process.env.TEST_BASE_URL ?? "http://localhost:9000",
        );
        const cleanup = new AbortController();
        const signal = AbortSignal.any([
            cleanup.signal,
            AbortSignal.timeout(50000),
        ]);
        const requests: Promise<Response>[] = [];
        const fixture = await _holdImage();

        t.after(async () => {
            cleanup.abort();
            await fixture.close();
            await Promise.allSettled(requests);
        });

        const activeCancellation = new AbortController();
        const active = _track(
            requests,
            _generate(
                endpoint,
                secretKey,
                `<h1>Active cancellation blocker</h1><img src="${fixture.imageUrl.href}">`,
                AbortSignal.any([activeCancellation.signal, signal]),
            ),
        );
        const activeOutcome = active.then(
            (response) => ({ response }),
            (error: unknown) => ({ error }),
        );
        await Promise.race([
            fixture.requested,
            active.then((response) => {
                throw new Error(
                    `Expected held image, but active request returned HTTP ${response.status}.`,
                );
            }),
            once(AbortSignal.timeout(20000), "abort").then(() => {
                throw new Error(
                    "Chrome did not request the held fixture image.",
                );
            }),
        ]);

        const queuedCandidates = Array.from({ length: 3 }, (_, index) =>
            _track(
                requests,
                _generate(
                    endpoint,
                    secretKey,
                    `<h1>After active cancellation ${index}</h1>`,
                    signal,
                ),
            ).then((response) => ({ index, response })),
        );
        const overflowResult = await Promise.race(queuedCandidates);
        assert.equal(
            overflowResult.response.status,
            429,
            "One request must be rejected after both pending slots fill.",
        );
        assert.deepEqual(await overflowResult.response.json(), {
            error: "PDF queue is full",
        });
        const queued = queuedCandidates
            .filter((_, index) => index !== overflowResult.index)
            .map((candidate) => candidate.then(({ response }) => response));

        activeCancellation.abort();
        const activeResult = await activeOutcome;
        assert.ok(
            "error" in activeResult,
            "Aborting an active client should reject its fetch.",
        );
        assert.equal(
            activeResult.error instanceof Error ? activeResult.error.name : "",
            "AbortError",
        );

        const queuedResponses = await Promise.race([
            Promise.all(queued),
            once(AbortSignal.timeout(20000), "abort").then(() => {
                throw new Error(
                    "The queued PDFs did not finish while the active image remained held.",
                );
            }),
        ]);
        await Promise.all(queuedResponses.map(_assertPdf));
    },
);
