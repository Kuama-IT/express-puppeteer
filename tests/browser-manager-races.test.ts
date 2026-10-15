import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { Page } from "puppeteer";

type Manager = {
    withPage(
        operation: (page: Page) => Promise<Buffer>,
        options: { signal: AbortSignal; timeoutMs: number },
    ): Promise<Buffer>;
    shutdown(): Promise<void>;
};

// Exercise the real source with controlled Puppeteer promises. No Chrome or
// HTTP service is required; transpilation does not write application artifacts.
test(
    "cancellation during acquisition preserves another active job",
    { timeout: 5000 },
    async (t) => {
        const fixture = await _fixture();
        const gate = Promise.withResolvers<string>();
        const checking = Promise.withResolvers<void>();
        const activeStarted = Promise.withResolvers<void>();
        const finishActive = Promise.withResolvers<Buffer>();
        t.after(async () => {
            gate.resolve("Chrome");
            finishActive.resolve(Buffer.alloc(0));
            await fixture.manager.shutdown();
        });
        const active = fixture.manager.withPage(
            () => {
                activeStarted.resolve();
                return finishActive.promise;
            },
            { signal: new AbortController().signal, timeoutMs: 4000 },
        );
        void active.catch(() => {});
        await activeStarted.promise;
        fixture.browser.version = () => {
            checking.resolve();
            return gate.promise;
        };
        const cancellation = new AbortController();
        const cancelled = fixture.manager.withPage(
            async () => assert.fail("Cancelled operation ran"),
            {
                signal: cancellation.signal,
                timeoutMs: 4000,
            },
        );
        const rejected = assert.rejects(cancelled, { name: "AbortError" });
        await checking.promise;
        cancellation.abort();
        // Must settle without waiting for the health check to finish.
        await rejected;
        gate.resolve("Chrome");
        finishActive.resolve(Buffer.from("active survived"));
        assert.equal((await active).toString(), "active survived");
        assert.equal(fixture.closedBrowsers, 0);
    },
);

test(
    "cancellation during context creation closes only the late context",
    { timeout: 5000 },
    async (t) => {
        const fixture = await _fixture();
        const creating = Promise.withResolvers<void>();
        const lateContext =
            Promise.withResolvers<ReturnType<typeof fixture.context>>();
        const activeStarted = Promise.withResolvers<void>();
        const finishActive = Promise.withResolvers<Buffer>();
        t.after(async () => {
            lateContext.resolve(fixture.context());
            finishActive.resolve(Buffer.alloc(0));
            await fixture.manager.shutdown();
        });
        const active = fixture.manager.withPage(
            () => {
                activeStarted.resolve();
                return finishActive.promise;
            },
            { signal: new AbortController().signal, timeoutMs: 4000 },
        );
        void active.catch(() => {});
        await activeStarted.promise;
        fixture.browser.createBrowserContext = () => {
            creating.resolve();
            return lateContext.promise;
        };
        const cancellation = new AbortController();
        const cancelled = fixture.manager.withPage(
            async () => assert.fail("Cancelled operation ran"),
            {
                signal: cancellation.signal,
                timeoutMs: 4000,
            },
        );
        const rejected = assert.rejects(cancelled, { name: "AbortError" });
        await creating.promise;
        cancellation.abort();
        const context = fixture.context();
        lateContext.resolve(context);
        await rejected;
        assert.equal(context.closed, true);
        assert.equal(fixture.closedBrowsers, 0);
        finishActive.resolve(Buffer.from("active survived"));
        assert.equal((await active).toString(), "active survived");
    },
);

test(
    "cold-launch deadline and lock-wait cancellation settle before launch completes",
    { timeout: 5000 },
    async (t) => {
        const launch = Promise.withResolvers<unknown>();
        const launching = Promise.withResolvers<void>();
        const fixture = await _fixture(() => {
            launching.resolve();
            return launch.promise;
        });
        t.after(async () => {
            launch.resolve(fixture.browser);
            await fixture.manager.shutdown();
        });
        const cold = fixture.manager.withPage(
            async () => assert.fail("Expired operation ran"),
            {
                signal: new AbortController().signal,
                timeoutMs: 50,
            },
        );
        const expired = assert.rejects(cold, { message: "PDF job timed out" });
        await launching.promise;
        const cancellation = new AbortController();
        const waiting = fixture.manager.withPage(
            async () => assert.fail("Cancelled waiter ran"),
            {
                signal: cancellation.signal,
                timeoutMs: 4000,
            },
        );
        const cancelled = assert.rejects(waiting, { name: "AbortError" });
        cancellation.abort();
        await Promise.all([expired, cancelled]);
        assert.equal(fixture.closedBrowsers, 0);
        launch.resolve(fixture.browser);
        const recovered = await fixture.manager.withPage(
            async () => Buffer.from("recovered"),
            {
                signal: new AbortController().signal,
                timeoutMs: 4000,
            },
        );
        assert.equal(recovered.toString(), "recovered");
        assert.equal(fixture.launches, 1);
        assert.equal(fixture.closedBrowsers, 0);
    },
);

test(
    "shutdown closes a browser returned by a late launch",
    { timeout: 5000 },
    async () => {
        const launch = Promise.withResolvers<unknown>();
        const launching = Promise.withResolvers<void>();
        const fixture = await _fixture(() => {
            launching.resolve();
            return launch.promise;
        });
        const cancellation = new AbortController();
        const job = fixture.manager.withPage(
            async () => assert.fail("Cancelled operation ran"),
            {
                signal: cancellation.signal,
                timeoutMs: 4000,
            },
        );
        const rejected = assert.rejects(job, { name: "AbortError" });
        await launching.promise;
        cancellation.abort();
        await rejected;
        const stopped = fixture.manager.shutdown();
        launch.resolve(fixture.browser);
        await stopped;
        assert.equal(fixture.closedBrowsers, 1);
    },
);

async function _fixture(launch?: () => Promise<unknown>) {
    const counts = { launches: 0, closedBrowsers: 0 };
    const browser = {
        connected: true,
        version: async () => "Chrome",
        createBrowserContext: async () => _context(),
        close: async () => {
            counts.closedBrowsers++;
        },
    };
    const errors = await _load("pdf-errors", {});
    const loaded = await _load("browser-manager.service", {
        puppeteer: {
            launch: () => {
                counts.launches++;
                return launch ? launch() : Promise.resolve(browser);
            },
        },
        "./config": {
            config: {
                pdf: { protocolTimeoutMs: 1000, cleanupTimeoutMs: 1000 },
            },
        },
        "./pdf-errors": errors,
    });
    return {
        manager: loaded.browserManagerService as Manager,
        browser,
        context: _context,
        get launches() {
            return counts.launches;
        },
        get closedBrowsers() {
            return counts.closedBrowsers;
        },
    };
}

function _context() {
    const state = { closed: false };
    return {
        newPage: async () => ({}) as Page,
        close: async () => {
            state.closed = true;
        },
        get closed() {
            return state.closed;
        },
    };
}

async function _load(
    name: string,
    dependencies: Record<string, unknown>,
): Promise<Record<string, unknown>> {
    const source = await readFile(
        new URL(`../src/${name}.ts`, import.meta.url),
        "utf8",
    );
    const compiled = ts.transpileModule(source, {
        compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.CommonJS,
            esModuleInterop: true,
        },
    });
    const exports = {};
    runInNewContext(compiled.outputText, {
        exports,
        AbortController,
        AbortSignal,
        Buffer,
        Promise,
        Error,
        setTimeout,
        clearTimeout,
        require: (name: string) => {
            assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
            return dependencies[name];
        },
    });
    return exports;
}
