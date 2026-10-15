import { browserManagerService } from "./browser-manager.service";
import { config } from "./config";
import { pdfQueueService } from "./pdf-queue.service";
import { pdfRendererService } from "./pdf-renderer.service";
import { pdfErrors } from "./pdf-errors";

const shutdownCancellation = new AbortController();
let acceptingJobs = true;

type GeneratePdfInput = {
    html: string;
    signal: AbortSignal;
};

export const pdfGenerationService = {
    async generate({ html, signal }: GeneratePdfInput): Promise<Buffer> {
        if (!acceptingJobs) throw pdfErrors.shuttingDown();
        const jobSignal = AbortSignal.any([
            signal,
            shutdownCancellation.signal,
        ]);
        const pdfQueueJob = () =>
            browserManagerService.withPage(
                (page) => pdfRendererService.render(page, html),
                { signal: jobSignal, timeoutMs: config.pdf.jobTimeoutMs },
            );
        try {
            return await pdfQueueService.run(pdfQueueJob, {
                signal: jobSignal,
            });
        } catch (error) {
            if (shutdownCancellation.signal.aborted)
                throw pdfErrors.shuttingDown();
            throw error;
        }
    },
    stopAccepting(): void {
        acceptingJobs = false;
    },
    cancelAll(): void {
        acceptingJobs = false;
        shutdownCancellation.abort(pdfErrors.shuttingDown());
    },
} as const;
