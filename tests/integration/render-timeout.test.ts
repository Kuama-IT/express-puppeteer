import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { _assertPdf, _generate, _holdImage, _track } from "../support/http.ts";

test(
    "times out a blocked render and accepts a later job",
    {
        skip:
            process.env.TEST_RENDER_TIMEOUT !== "1"
                ? "Set TEST_RENDER_TIMEOUT=1 after starting the service with PDF_JOB_TIMEOUT_MS=15000."
                : false,
        timeout: 75000,
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
            AbortSignal.timeout(60000),
        ]);
        const requests: Promise<Response>[] = [];
        const image = await _holdImage();

        t.after(async () => {
            cancellation.abort();
            image.release();
            await image.close();
            await Promise.allSettled(requests);
        });

        const warmup = _track(
            requests,
            _generate(endpoint, secretKey, "<h1>Warm browser</h1>", signal),
        );
        await _assertPdf(await warmup);

        const timedOut = _track(
            requests,
            _generate(
                endpoint,
                secretKey,
                `<img src="${image.imageUrl.href}">`,
                signal,
            ),
        );
        await Promise.race([
            image.requested,
            timedOut.then((response) => {
                throw new Error(
                    `Expected the fixture image to block rendering, but received HTTP ${response.status}.`,
                );
            }),
            once(AbortSignal.timeout(20000), "abort").then(() => {
                throw new Error(
                    `Chrome did not reach ${image.imageUrl.origin}; check TEST_ASSET_HOST and container-to-host connectivity.`,
                );
            }),
        ]);

        const timeoutResponse = await timedOut;
        assert.equal(timeoutResponse.status, 504);
        assert.deepEqual(await timeoutResponse.json(), {
            error: "PDF job timed out",
        });

        const recovered = _track(
            requests,
            _generate(
                endpoint,
                secretKey,
                "<h1>Recovered after timeout</h1>",
                signal,
            ),
        );
        await _assertPdf(await recovered);
    },
);
