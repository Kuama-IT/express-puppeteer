import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import {
    assertDedicatedContainer,
    assertEndpointMapsToContainer,
    docker,
    requireDedicatedContainer,
} from "../support/docker.ts";
import { _assertPdf, _generate, _holdImage, _track } from "../support/http.ts";

const blockedShutdown = process.env.TEST_SHUTDOWN_BLOCKED === "1";

test(
    blockedShutdown
        ? "cancels a permanently blocked PDF and exits before the shutdown grace expires"
        : "stops the dedicated container and leaves it exited after browser shutdown",
    {
        skip:
            process.env.TEST_SHUTDOWN !== "1"
                ? "Set TEST_SHUTDOWN=1 to opt into stopping the dedicated container."
                : false,
        timeout: 120000,
    },
    async (t) => {
        const { container, endpoint } = requireDedicatedContainer();
        const secretKey = process.env.SECRET_KEY;
        assert.ok(
            secretKey,
            "Set SECRET_KEY to the API key used by the running service.",
        );
        await assertDedicatedContainer(container);
        await assertEndpointMapsToContainer(container, endpoint);

        const cancellation = new AbortController();
        const requests: Promise<Response>[] = [];
        const image = await _holdImage();
        let stopping: Promise<string> | undefined = undefined;
        t.after(async () => {
            cancellation.abort();
            image.release();
            await image.close();
            await Promise.allSettled([
                ...requests,
                ...(stopping ? [stopping] : []),
            ]);
        });
        const activeRequest = _track(
            requests,
            _generate(
                endpoint,
                secretKey,
                `<h1>Graceful shutdown</h1><img src="${image.imageUrl.href}">`,
                AbortSignal.any([
                    cancellation.signal,
                    AbortSignal.timeout(90000),
                ]),
            ),
        );
        await Promise.race([
            image.requested,
            activeRequest.then((response) => {
                throw new Error(
                    `Expected the fixture image to hold the active job, but received HTTP ${response.status}.`,
                );
            }),
            once(AbortSignal.timeout(20000), "abort").then(() => {
                throw new Error(
                    "Chrome did not reach the host fixture server.",
                );
            }),
        ]);

        stopping = docker(
            container,
            ["stop", "--time", "60", container],
            75000,
        );
        void stopping.catch(() => {});
        await _waitForServerClose(endpoint);
        if (!blockedShutdown) image.release();
        const response = await activeRequest;
        if (blockedShutdown) {
            assert.equal(response.status, 503);
            assert.deepEqual(await response.json(), {
                error: "PDF service is shutting down",
            });
        } else {
            await _assertPdf(response);
        }
        await stopping;

        const result = await docker(container, [
            "inspect",
            "--format",
            "{{json .State}}",
            container,
        ]);
        const state = JSON.parse(result) as {
            Status: string;
            ExitCode: number;
            OOMKilled: boolean;
        };
        assert.equal(state.Status, "exited");
        assert.equal(
            state.ExitCode,
            0,
            "Graceful SIGTERM shutdown should exit successfully.",
        );
        assert.equal(
            state.OOMKilled,
            false,
            "The shutdown must not be caused by an OOM kill.",
        );
    },
);

async function _waitForServerClose(endpoint: URL): Promise<void> {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(endpoint, {
                method: "GET",
                signal: AbortSignal.timeout(500),
            });
            await response.arrayBuffer();
        } catch {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
        "The service did not stop accepting new connections after docker stop.",
    );
}
