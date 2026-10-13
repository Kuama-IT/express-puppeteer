import { Browser, Page } from "puppeteer";
import { browserService } from "./browser.service";
import {
    pdfService,
    CONTENT_TIMEOUT_MS,
    RENDER_TIMEOUT_MS,
} from "./pdf.service";
import { PdfQueue, requestCancelled } from "./pdf.queue";
import { utils } from "./utils";

const queue = new PdfQueue(
    utils.parsePositiveInteger(process.env.PDF_CONCURRENCY, 1),
    utils.parseNonNegativeInteger(process.env.PDF_MAX_PENDING, 2),
    utils.parsePositiveInteger(process.env.PDF_QUEUE_TIMEOUT_MS, 30000),
);

const JOB_TIMEOUT_MS = utils.parsePositiveInteger(
    process.env.PDF_JOB_TIMEOUT_MS,
    CONTENT_TIMEOUT_MS + RENDER_TIMEOUT_MS + browserService.protocolTimeout,
);

type PdfRenderContext = {
    html: string;
    page?: Page;
    cancelled: boolean;
    cleanup?: Promise<void>;
};

const closePage = (
    context: PdfRenderContext,
    browser: Browser,
): Promise<void> => {
    if (!context.page) return Promise.resolve();
    context.cleanup ??= utils
        .withTimeout(
            Promise.resolve().then(() => context.page!.close()),
            browserService.healthTimeout,
            "Page close timed out",
        )
        .catch(() => browserService.invalidate(browser));
    return context.cleanup;
};

export const pdfOrchestrator = {
    generate: async (html: string, signal: AbortSignal): Promise<Buffer> => {
        const context: PdfRenderContext = { cancelled: false, html };
        try {
            return await queue
                .run(async () => {
                    let browser: Browser | undefined;
                    let onAbort: (() => void) | undefined;
                    const aborted = new Promise<never>((_, reject) => {
                        onAbort = () => {
                            context.cancelled = true;
                            context.html = "";
                            reject(requestCancelled());
                        };
                        signal.addEventListener("abort", onAbort, { once: true });
                        if (signal.aborted) onAbort();
                    });
                    try {
                        const operation = async () => {
                            if (context.cancelled) throw requestCancelled();
                            browser = await browserService.get();
                            if (context.cancelled) throw requestCancelled();
                            try {
                                context.page = await browser.newPage();
                                if (context.cancelled) throw requestCancelled();
                                const rendering = pdfService.render(context.page, context.html);
                                context.html = "";
                                return await rendering;
                            } finally {
                                // Also close a page that arrives after cancellation or timeout.
                                await closePage(context, browser);
                            }
                        };
                        return await utils.withTimeout(
                            Promise.race([operation(), aborted]),
                            JOB_TIMEOUT_MS,
                            "PDF job timed out",
                        );
                    } catch (error) {
                        context.cancelled = true;
                        context.html = "";
                        if (browser) {
                            await closePage(context, browser);
                            if (!signal.aborted) {
                                await browserService.invalidateIfUnhealthy(browser);
                            }
                        }
                        throw error;
                    } finally {
                        if (onAbort) signal.removeEventListener("abort", onAbort);
                    }
                }, signal);
        } finally {
            context.html = "";
        }
    },
};
