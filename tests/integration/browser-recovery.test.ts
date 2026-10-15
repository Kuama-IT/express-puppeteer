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

test(
    "launches a fresh browser after the dedicated container's Chrome process is killed",
    {
        skip:
            process.env.TEST_BROWSER_RECOVERY !== "1"
                ? "Set TEST_BROWSER_RECOVERY=1 to opt into killing Chrome in the dedicated container."
                : false,
        timeout: 90000,
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
        const signal = AbortSignal.any([
            cancellation.signal,
            AbortSignal.timeout(70000),
        ]);
        const image = await _holdImage();
        t.after(async () => {
            cancellation.abort();
            image.release();
            await image.close();
            await Promise.allSettled(requests);
        });
        const warmup = _track(
            requests,
            _generate(endpoint, secretKey, "<h1>Start Chrome</h1>", signal),
        );
        await _assertPdf(await warmup);

        const activeRequest = _track(
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
            activeRequest.then((response) => {
                throw new Error(
                    `Expected Chrome to wait for the fixture image, but received HTTP ${response.status}.`,
                );
            }),
            once(AbortSignal.timeout(20000), "abort").then(() => {
                throw new Error(
                    "Chrome did not reach the host fixture server.",
                );
            }),
        ]);

        const processes = await docker(container, [
            "exec",
            container,
            "ps",
            "-eo",
            "pid,args",
        ]);
        const chromePid = _chromeRootPid(processes);
        await docker(container, ["exec", container, "kill", "-9", chromePid]);

        const failure = await activeRequest;
        assert.equal(
            failure.status,
            500,
            "The active job should fail when its Chrome process is killed.",
        );
        await failure.arrayBuffer();

        let recovered: Response | undefined;
        for (let attempt = 0; attempt < 4; attempt++) {
            recovered = await _track(
                requests,
                _generate(
                    endpoint,
                    secretKey,
                    "<h1>Fresh browser</h1>",
                    signal,
                ),
            );
            if (recovered.status === 200) break;
            await recovered.arrayBuffer();
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
        assert.ok(recovered, "Expected a recovery response.");
        assert.equal(
            recovered.status,
            200,
            "The service should launch a fresh Chrome after detecting the killed browser.",
        );
        await _assertPdf(recovered);
        const after = await docker(container, [
            "exec",
            container,
            "ps",
            "-eo",
            "pid,args",
        ]);
        assert.notEqual(
            _chromeRootPid(after),
            chromePid,
            "Recovery should use a newly launched Chrome root process.",
        );
    },
);

function _chromeRootPid(processes: string): string {
    const entries = processes
        .split("\n")
        .slice(1)
        .map((line) => line.trim())
        .filter(Boolean);
    const candidates = entries.flatMap((line) => {
        const match = line.match(/^(\d+)\s+(.*)$/);
        if (!match) return [];
        const [, pid, command] = match;
        if (!/\/chrome(?:\s|$)/.test(command) || /--type=/.test(command))
            return [];
        return [pid];
    });
    assert.equal(
        candidates.length,
        1,
        `Expected one Chrome root process in the dedicated container; found ${candidates.length}.`,
    );
    return candidates[0];
}
