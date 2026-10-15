import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const _execFile = promisify(execFile);
const _requestTimeoutMs = 20000;
const _maxRounds = 5;
const _maxConcurrency = 8;
const _localHosts = new Set(["localhost", "127.0.0.1", "::1"]);

type RequestOutcome = {
    kind: "pdf" | "pressure" | "aborted";
    latencyMs: number;
    status?: number;
};

test(
    "bounded mixed PDF load recovers after client aborts",
    {
        skip: process.env.TEST_STRESS !== "1",
        timeout: 240000,
    },
    async (t) => {
        const secretKey = process.env.SECRET_KEY;
        assert.ok(
            secretKey,
            "Set SECRET_KEY to the API key used by the running service.",
        );

        const baseUrl = process.env.TEST_BASE_URL ?? "http://localhost:9000";
        const base = new URL(baseUrl);
        const hostname = base.hostname.replace(/^\[|\]$/g, "");
        assert.ok(
            _localHosts.has(hostname),
            "Stress testing is restricted to a local TEST_BASE_URL.",
        );
        assert.ok(
            base.protocol === "http:" || base.protocol === "https:",
            "TEST_BASE_URL must use HTTP or HTTPS.",
        );

        const rounds = _readBoundedInteger(
            "TEST_STRESS_ROUNDS",
            2,
            1,
            _maxRounds,
        );
        const concurrency = _readBoundedInteger(
            "TEST_STRESS_CONCURRENCY",
            4,
            2,
            _maxConcurrency,
        );
        const endpoint = new URL("/api/", base);
        const cancellation = new AbortController();
        const requests: Promise<unknown>[] = [];

        t.after(async () => {
            cancellation.abort();
            await Promise.allSettled(requests);
        });

        // Start Chrome and let its steady processes exist before taking the baseline.
        const warmup = await _generate(
            endpoint,
            secretKey,
            0,
            0,
            cancellation.signal,
            false,
        );
        assert.equal(
            warmup.kind,
            "pdf",
            "Warmup request must produce a valid PDF.",
        );
        const before = await _sampleContainer();
        const batches: RequestOutcome[][] = [];
        for (let round = 0; round < rounds; round += 1) {
            const startedAt = performance.now();
            const outcomes = await Promise.all(
                Array.from({ length: concurrency }, (_, index) => {
                    const shouldAbort = index === concurrency - 1;
                    const request = _generate(
                        endpoint,
                        secretKey,
                        round,
                        index,
                        cancellation.signal,
                        shouldAbort,
                    );
                    requests.push(request);
                    return request;
                }),
            );
            batches.push(outcomes);
            const counts = _countOutcomes(outcomes);
            console.log(
                `stress round=${round + 1}/${rounds} elapsedMs=${Math.round(performance.now() - startedAt)} ` +
                    `pdf=${counts.pdf} pressure=${counts.pressure} aborted=${counts.aborted} ` +
                    `latencyMs=${outcomes.map(({ latencyMs }) => Math.round(latencyMs)).join(",")}`,
            );
            assert.ok(
                counts.pdf + counts.pressure + counts.aborted === concurrency,
            );
        }

        // A normal request after the load is a direct recovery check, independent of
        // whether the server returned overload responses during the mixed batches.
        let recovered: RequestOutcome | undefined;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const recovery = _generate(
                endpoint,
                secretKey,
                rounds,
                attempt,
                cancellation.signal,
                false,
            );
            requests.push(recovery);
            const outcome = await recovery;
            if (outcome.kind === "pdf") {
                recovered = outcome;
                break;
            }
            assert.equal(
                outcome.kind,
                "pressure",
                "Recovery probe returned an unexpected outcome.",
            );
            if (attempt < 2)
                await new Promise((resolve) => setTimeout(resolve, 500));
        }
        assert.ok(
            recovered,
            "Service should return a valid PDF after transient overload clears.",
        );

        let after = await _sampleContainer();
        if (before && after) {
            // Client cancellation can take a moment to propagate through Chrome and
            // the queue. Give zombie counts a bounded settling window to reach baseline.
            for (
                let attempt = 0;
                attempt < 10 && after.zombies > before.zombies;
                attempt += 1
            ) {
                await new Promise((resolve) => setTimeout(resolve, 500));
                after = await _sampleContainer();
                assert.ok(after);
            }
            console.log(
                `stress container before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
            );
            assert.ok(
                after.zombies <= before.zombies,
                "Zombie process count did not return to baseline after settling.",
            );
        }

        const summary = batches.flat().reduce(
            (counts, outcome) => {
                counts[outcome.kind] += 1;
                return counts;
            },
            { pdf: 0, pressure: 0, aborted: 0 },
        );
        console.log(
            `stress summary rounds=${rounds} concurrency=${concurrency} recoveryLatencyMs=${Math.round(recovered.latencyMs)} outcomes=${JSON.stringify(summary)}`,
        );
    },
);

function _readBoundedInteger(
    name: string,
    fallback: number,
    minimum: number,
    maximum: number,
): number {
    const value = process.env[name];
    if (value === undefined) return fallback;
    assert.match(value, /^\d+$/, `${name} must be an integer.`);
    const parsed = Number(value);
    assert.ok(
        Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum,
        `${name} must be between ${minimum} and ${maximum}.`,
    );
    return parsed;
}

async function _generate(
    endpoint: URL,
    secretKey: string,
    round: number,
    index: number,
    testSignal: AbortSignal,
    shouldAbort: boolean,
): Promise<RequestOutcome> {
    const controller = new AbortController();
    const signal = AbortSignal.any([
        controller.signal,
        testSignal,
        AbortSignal.timeout(_requestTimeoutMs),
    ]);
    const startedAt = performance.now();
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    if (shouldAbort) abortTimer = setTimeout(() => controller.abort(), 20);

    try {
        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": secretKey,
            },
            body: JSON.stringify({
                html: `<html><body><h1>Stress ${round}-${index}</h1><p>Bounded PDF load probe.</p></body></html>`,
            }),
            signal,
        });
        const latencyMs = performance.now() - startedAt;
        if (response.status === 429 || response.status === 503) {
            await response.body?.cancel();
            return { kind: "pressure", latencyMs, status: response.status };
        }
        assert.equal(
            response.status,
            200,
            `Unexpected HTTP ${response.status} during stress request.`,
        );
        assert.match(
            response.headers.get("content-type") ?? "",
            /^application\/pdf(?:;|$)/i,
        );

        const bytes = Buffer.from(await response.arrayBuffer());
        assert.equal(
            bytes.subarray(0, 5).toString("ascii"),
            "%PDF-",
            "Accepted response must contain a PDF.",
        );
        return { kind: "pdf", latencyMs, status: response.status };
    } catch (error) {
        if (shouldAbort && _isAbortError(error)) {
            return {
                kind: "aborted",
                latencyMs: performance.now() - startedAt,
            };
        }
        throw error;
    } finally {
        if (abortTimer !== undefined) clearTimeout(abortTimer);
    }
}

function _isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === "AbortError";
}

function _countOutcomes(
    outcomes: RequestOutcome[],
): Record<RequestOutcome["kind"], number> {
    return outcomes.reduce(
        (counts, outcome) => {
            counts[outcome.kind] += 1;
            return counts;
        },
        { pdf: 0, pressure: 0, aborted: 0 },
    );
}

type ContainerSample = { pids: number; zombies: number; memory: string };

async function _sampleContainer(): Promise<ContainerSample | undefined> {
    const container = process.env.TEST_CONTAINER;
    if (container === undefined) return undefined;
    assert.match(
        container,
        /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/,
        "TEST_CONTAINER must be a container name or ID.",
    );

    const stats = await _execFile(
        "docker",
        [
            "stats",
            "--no-stream",
            "--format",
            "{{.PIDs}}|{{.MemUsage}}",
            container,
        ],
        { timeout: 10000 },
    );
    const [pidText, memory = "unknown"] = stats.stdout.trim().split("|");
    const pids = Number(pidText);
    assert.ok(
        Number.isSafeInteger(pids) && pids >= 0,
        "Could not read container PID count from docker stats.",
    );

    const processList = await _execFile(
        "docker",
        ["exec", container, "ps", "-eo", "stat="],
        { timeout: 10000 },
    );
    const zombies = processList.stdout
        .split(/\r?\n/)
        .filter((line) => /^\s*Z/.test(line)).length;
    return { pids, zombies, memory };
}
