import puppeteer, { Browser, BrowserContext, Page } from "puppeteer";
import { config } from "./config";
import { pdfErrors } from "./pdf-errors";

type WithPageOptions = {
    signal: AbortSignal;
    timeoutMs: number;
};

type PageOperation = (page: Page) => Promise<Buffer>;

type PageLifecycle = {
    browser?: Browser;
    context?: BrowserContext;
    contextCreation?: Promise<BrowserContext>;
};

let browser: Browser | undefined;
let browserLock: Promise<unknown> = Promise.resolve();
let shuttingDown = false;

export const browserManagerService = {
    async withPage(
        operation: PageOperation,
        { signal, timeoutMs }: WithPageOptions,
    ): Promise<Buffer> {
        const lifecycle: PageLifecycle = {};
        const deadline = new AbortController();
        const jobSignal = AbortSignal.any([signal, deadline.signal]);
        const timer = setTimeout(
            () => deadline.abort(pdfErrors.jobTimeout()),
            timeoutMs,
        );

        try {
            jobSignal.throwIfAborted();
            const acquired = await _untilAborted(
                _getOrLaunch(jobSignal),
                jobSignal,
            );
            jobSignal.throwIfAborted();
            lifecycle.browser = acquired;

            // Isolate cookies and storage for each PDF while sharing the browser.
            lifecycle.contextCreation = acquired.createBrowserContext();
            lifecycle.context = await _untilAborted(
                lifecycle.contextCreation,
                jobSignal,
            );
            jobSignal.throwIfAborted();

            const page = await _untilAborted(
                lifecycle.context.newPage(),
                jobSignal,
            );
            jobSignal.throwIfAborted();

            const result = await _untilAborted(operation(page), jobSignal);
            jobSignal.throwIfAborted();
            return result;
        } finally {
            clearTimeout(timer);
            await _cleanupPageOperation(lifecycle);
        }
    },

    shutdown(): Promise<void> {
        shuttingDown = true;
        return _withBrowserLock(async () => {
            if (browser) await _closeBrowser(browser);
        });
    },
} as const;

function _getOrLaunch(signal: AbortSignal): Promise<Browser> {
    return _withBrowserLock(async () => {
        signal.throwIfAborted();
        if (shuttingDown) throw pdfErrors.shuttingDown();
        if (browser) {
            const currentBrowser = browser;

            if (currentBrowser.connected) {
                try {
                    await _waitAtMost(
                        currentBrowser.version(),
                        config.pdf.cleanupTimeoutMs,
                        "Browser health check timed out",
                    );
                    return currentBrowser;
                } catch {
                    await _closeBrowser(currentBrowser);
                }
            } else {
                await _closeBrowser(currentBrowser);
            }
        }

        signal.throwIfAborted();
        if (shuttingDown) throw pdfErrors.shuttingDown();
        browser = await puppeteer.launch({
            headless: true,
            timeout: 30000,
            protocolTimeout: config.pdf.protocolTimeoutMs,
            handleSIGHUP: false,
            handleSIGINT: false,
            handleSIGTERM: false,
            args: ["--no-sandbox"],
        });
        // Launch belongs to the manager, not to the request that first needed it.
        // Keep a late successful launch for other jobs unless shutdown has started.
        if (shuttingDown) {
            await _closeBrowser(browser);
            throw pdfErrors.shuttingDown();
        }
        return browser;
    });
}

async function _untilAborted<T>(
    operation: Promise<T>,
    signal: AbortSignal,
): Promise<T> {
    let onAbort = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
    });
    try {
        return await Promise.race([operation, cancelled]);
    } finally {
        signal.removeEventListener("abort", onAbort);
    }
}

async function _cleanupPageOperation(lifecycle: PageLifecycle): Promise<void> {
    if (lifecycle.context && lifecycle.browser) {
        await _closeContext(lifecycle.context, lifecycle.browser);
    } else if (lifecycle.contextCreation && lifecycle.browser) {
        // Cancellation during creation does not make the shared browser unhealthy.
        // Close this job's late context; only escalate if bounded cleanup fails.
        const closeLateContext = lifecycle.contextCreation.then((context) =>
            context.close(),
        );
        try {
            await _waitAtMost(
                closeLateContext,
                config.pdf.cleanupTimeoutMs,
                "Context creation cleanup timed out",
            );
        } catch {
            await _retireBrowser(lifecycle.browser);
        }
    }
}

function _withBrowserLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = browserLock.then(operation);
    browserLock = result.catch(() => undefined);
    return result;
}

async function _waitAtMost<T>(
    operation: Promise<T>,
    milliseconds: number,
    message: string,
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error(message)),
                    milliseconds,
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

async function _closeBrowser(target: Browser): Promise<void> {
    if (browser === target) browser = undefined;
    try {
        await _waitAtMost(
            target.close(),
            config.pdf.cleanupTimeoutMs,
            "Browser close timed out",
        );
    } catch {
        const child = target.process();
        if (child?.exitCode === null) child.kill("SIGKILL");
        await target.disconnect().catch(() => undefined);
    }
}

function _retireBrowser(target: Browser): Promise<void> {
    return _withBrowserLock(async () => {
        if (browser === target) await _closeBrowser(target);
    });
}

async function _closeContext(
    context: BrowserContext,
    owner: Browser,
): Promise<void> {
    try {
        await _waitAtMost(
            context.close(),
            config.pdf.cleanupTimeoutMs,
            "Browser context close timed out",
        );
    } catch {
        await _retireBrowser(owner);
    }
}
