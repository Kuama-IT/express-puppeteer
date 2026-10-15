import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import test from "node:test";
import type { Browser, BrowserContext, Page } from "puppeteer";

// Load the application's CommonJS build, not a second implementation.
type BrowserManagerModule = {
    browserManagerService: {
        withPage(
            operation: (page: Page) => Promise<Buffer>,
            options: { signal: AbortSignal; timeoutMs: number },
        ): Promise<Buffer>;
        shutdown(): Promise<void>;
    };
};

test(
    "isolates cookies and local storage while reusing the browser",
    {
        skip:
            process.env.TEST_BROWSER_MANAGER !== "1"
                ? "Set TEST_BROWSER_MANAGER=1 in the built Docker image (see tests/README.md)."
                : false,
        timeout: 60000,
    },
    async (t) => {
        const require = createRequire(import.meta.url);
        const { browserManagerService } =
            require("../../dist/browser-manager.service.js") as BrowserManagerModule;
        const cancellation = new AbortController();
        const assets = createServer((_request, response) => {
            response.writeHead(200, {
                "Content-Type": "text/html",
                "Cache-Control": "no-store",
            });
            response.end("<!doctype html><title>Context isolation</title>");
        });

        t.after(async () => {
            cancellation.abort();
            try {
                await browserManagerService.shutdown();
            } finally {
                assets.closeAllConnections();
                await new Promise<void>((resolve) =>
                    assets.close(() => resolve()),
                );
            }
        });

        assets.listen(0, "127.0.0.1");
        await once(assets, "listening");
        const address = assets.address();
        assert.ok(address && typeof address !== "string");
        const url = `http://127.0.0.1:${address.port}/`;
        const token = randomUUID();
        const options = { signal: cancellation.signal, timeoutMs: 25000 };
        let firstBrowser: Browser | undefined;
        let firstContext: BrowserContext | undefined;

        await browserManagerService.withPage(async (page) => {
            firstBrowser = page.browser();
            firstContext = page.browserContext();
            // Navigate the top-level document: storage in an about:blank iframe
            // can be denied by browser policy independently of context isolation.
            await page.goto(url, {
                waitUntil: "domcontentloaded",
                timeout: 10000,
            });
            const seeded = await page.evaluate((value) => {
                localStorage.setItem("isolation", value);
                document.cookie = `isolation=${value}; Path=/; SameSite=Lax`;
                return {
                    local: localStorage.getItem("isolation"),
                    cookie: document.cookie,
                };
            }, token);
            assert.deepEqual(seeded, {
                local: token,
                cookie: `isolation=${token}`,
            });
            return Buffer.alloc(0);
        }, options);

        assert.ok(firstBrowser);
        assert.ok(firstContext);
        assert.ok(
            !firstBrowser.browserContexts().includes(firstContext),
            "The first context must be closed after its operation.",
        );

        await browserManagerService.withPage(async (page) => {
            assert.equal(
                page.browser(),
                firstBrowser,
                "Isolation must not rely on launching a new browser.",
            );
            assert.notEqual(page.browserContext(), firstContext);
            await page.goto(url, {
                waitUntil: "domcontentloaded",
                timeout: 10000,
            });
            const stored = await page.evaluate(() => ({
                local: localStorage.getItem("isolation"),
                cookie: document.cookie,
            }));
            assert.deepEqual(stored, { local: null, cookie: "" });
            return Buffer.alloc(0);
        }, options);
    },
);
