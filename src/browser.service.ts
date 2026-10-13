import puppeteer, { Browser } from "puppeteer";
import { utils } from "./utils";

let browser: Browser | undefined;

const browserLock = (() => {
    let pending: Promise<unknown> = Promise.resolve();

    return {
        // Serialize health checks, launches, and retirement, even with multiple jobs.
        exclusive: <T>(operation: () => Promise<T>): Promise<T> => {
            const result = pending.then(operation);
            pending = result.catch(() => undefined);
            return result;
        },
    };
})();

export const browserService = {
    get protocolTimeout(): number {
        return utils.parsePositiveInteger(
            process.env.PROTOCOL_TIMEOUT_MS,
            360000,
        );
    },
    get healthTimeout(): number {
        return Math.min(browserService.protocolTimeout, 10000);
    },
    launch: (): Promise<Browser> =>
        puppeteer.launch({
            headless: true,
            protocolTimeout: browserService.protocolTimeout,
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-breakpad",
                "--disable-crash-reporter",
                "--disable-crashpad",
            ],
        }),

    retire: async (target: Browser): Promise<void> => {
        if (browser === target) browser = undefined;
        try {
            await utils.withTimeout(
                target.close(),
                browserService.healthTimeout,
                "Browser close timed out",
            );
        } catch {
            const child = target.process();
            if (child && child.exitCode === null) child.kill("SIGKILL");
            await target.disconnect().catch(() => undefined);
        }
    },

    checkHealth: async (target: Browser): Promise<void> => {
        if (!target.connected) throw new Error("Browser disconnected");
        await utils.withTimeout(
            target.version(),
            browserService.healthTimeout,
            "Browser health check timed out",
        );
    },

    get: (): Promise<Browser> =>
        browserLock.exclusive(async () => {
            if (browser) {
                const current = browser;
                try {
                    await browserService.checkHealth(current);
                    return current;
                } catch {
                    await browserService.retire(current);
                }
            }
            const launched = await browserService.launch();
            browser = launched;
            return launched;
        }),

    invalidate: (target: Browser): Promise<void> =>
        browserLock.exclusive(async () => {
            // Cleanup failures require retirement, even if CDP still responds.
            if (browser === target) await browserService.retire(target);
        }),

    invalidateIfUnhealthy: (target: Browser): Promise<void> =>
        browserLock.exclusive(async () => {
            // A failing job from an old browser must not retire its replacement.
            if (browser !== target) return;
            try {
                await browserService.checkHealth(target);
            } catch {
                await browserService.retire(target);
            }
        }),
};
