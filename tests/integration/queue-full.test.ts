import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import test from "node:test";

// Requires an idle service with concurrency=1, maxPending=2, queueTimeoutMs=30000.
test(
    "rejects excess requests with 429 and completes accepted PDFs after the queue drains",
    {
        timeout: 90000,
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
            AbortSignal.timeout(80000),
        ]);
        const requests: Promise<Response>[] = [];
        const imageRequested = Promise.withResolvers<void>();
        const imagePath = `/blocked-${randomUUID()}.svg`;
        let imageResponse: ServerResponse | undefined;

        // Chrome must reach this host-side server; keep its image response open until
        // overload has been observed, rather than relying on rendering duration.
        const assets = createServer((request, response) => {
            if (request.url !== imagePath) {
                response.writeHead(404).end();
                return;
            }
            imageResponse = response;
            response.writeHead(200, {
                "Content-Type": "image/svg+xml",
                "Cache-Control": "no-store",
            });
            response.flushHeaders();
            imageRequested.resolve();
        });

        t.after(async () => {
            cancellation.abort();
            imageResponse?.destroy();
            assets.closeAllConnections();
            await new Promise<void>((resolve) => assets.close(() => resolve()));
            await Promise.allSettled(requests);
        });

        assets.listen(0, "0.0.0.0");
        await once(assets, "listening");
        const address = assets.address();
        assert.ok(address && typeof address !== "string");
        const assetHost = process.env.TEST_ASSET_HOST ?? "host.docker.internal";
        const imageUrl = new URL(
            imagePath,
            `http://${assetHost}:${address.port}`,
        );

        const activeRequest = _generate(
            endpoint,
            secretKey,
            `<h1>Blocked PDF</h1><img src="${imageUrl.href}">`,
            signal,
        );
        requests.push(activeRequest);

        // Fail immediately if the PDF completes/errors instead of loading our image.
        await Promise.race([
            imageRequested.promise,
            activeRequest.then((response) => {
                throw new Error(
                    `Expected Chrome to wait for the fixture image, but the request returned HTTP ${response.status}.`,
                );
            }),
            once(AbortSignal.timeout(20000), "abort").then(() => {
                throw new Error(
                    `Chrome did not reach ${imageUrl.origin}. Check TEST_ASSET_HOST and container-to-host connectivity.`,
                );
            }),
        ]);

        const overflowRequests = Array.from({ length: 3 }, (_, index) =>
            _generate(
                endpoint,
                secretKey,
                `<h1>Queued PDF ${index}</h1>`,
                signal,
            ),
        );
        requests.push(...overflowRequests);

        // With the only active slot blocked, the first response must be the rejected
        // request. Neither queued request can render until we release the image.
        const rejected = await Promise.race([
            ...overflowRequests,
            once(AbortSignal.timeout(10000), "abort").then(() => {
                throw new Error(
                    "No overload response received. Expected PDF_CONCURRENCY=1 and PDF_MAX_PENDING=2 on an idle service.",
                );
            }),
        ]);
        assert.equal(rejected.status, 429);
        assert.deepEqual(await rejected.json(), { error: "PDF queue is full" });

        assert.ok(imageResponse);
        imageResponse.end(
            '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>',
        );

        const responses = await Promise.all(requests);
        assert.deepEqual(
            responses.map((response) => response.status).sort(),
            [200, 200, 200, 429],
        );
        for (const response of responses) {
            if (response.status !== 200) continue;
            assert.match(
                response.headers.get("content-type") ?? "",
                /^application\/pdf(?:;|$)/i,
            );
            const pdf = Buffer.from(await response.arrayBuffer());
            assert.equal(pdf.subarray(0, 5).toString("ascii"), "%PDF-");
        }
    },
);

function _generate(
    endpoint: URL,
    secretKey: string,
    html: string,
    signal: AbortSignal,
): Promise<Response> {
    return fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": secretKey },
        body: JSON.stringify({ html }),
        signal,
    });
}
