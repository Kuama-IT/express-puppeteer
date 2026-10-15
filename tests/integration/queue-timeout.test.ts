import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { _assertPdf, _generate, _holdImage, _track } from "../support/http.ts";

// Requires an idle service with concurrency=1, maxPending=2, queueTimeoutMs=30000.
test(
    "returns 503 when queue wait expires and accepts work after the timeout",
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
        const cancellation = new AbortController();
        const signal = AbortSignal.any([
            cancellation.signal,
            AbortSignal.timeout(50000),
        ]);
        const requests: Promise<Response>[] = [];
        const fixture = await _holdImage();

        t.after(async () => {
            cancellation.abort();
            await fixture.close();
            await Promise.allSettled(requests);
        });

        const active = _track(
            requests,
            _generate(
                endpoint,
                secretKey,
                `<h1>Queue timeout blocker</h1><img src="${fixture.imageUrl.href}">`,
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

        const timedOut = _track(
            requests,
            _generate(
                endpoint,
                secretKey,
                "<h1>Wait for queue timeout</h1>",
                signal,
            ),
        );
        const timeoutResponse = await timedOut;
        assert.equal(timeoutResponse.status, 503);
        assert.deepEqual(await timeoutResponse.json(), {
            error: "PDF queue wait timed out",
        });

        const recovery = _track(
            requests,
            _generate(
                endpoint,
                secretKey,
                "<h1>Queue timeout recovery</h1>",
                signal,
            ),
        );
        fixture.release();

        const [activeResponse, recoveryResponse] = await Promise.all([
            active,
            recovery,
        ]);
        await _assertPdf(activeResponse);
        await _assertPdf(recoveryResponse);
    },
);
