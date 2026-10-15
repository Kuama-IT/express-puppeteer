import { config } from "./config";
import { pdfErrors } from "./pdf-errors";

type QueueRunOptions = {
    signal: AbortSignal;
};

type PendingJob = {
    start: () => Promise<void>;
    reject: (error: Error) => void;
    signal: AbortSignal;
    onAbort: () => void;
    deadline: number;
    timer?: ReturnType<typeof setTimeout>;
};

let activeJobs = 0;
const pendingJobs = new Map<symbol, PendingJob>();

export const pdfQueueService = {
    run<T>(
        operation: () => Promise<T>,
        { signal }: QueueRunOptions,
    ): Promise<T> {
        if (signal.aborted) {
            return Promise.reject(pdfErrors.requestCancelled());
        }

        if (
            activeJobs >= config.pdf.concurrency &&
            pendingJobs.size >= config.pdf.maxPending
        ) {
            return Promise.reject(pdfErrors.queueFull());
        }

        return new Promise<T>((resolve, reject) => {
            const id = Symbol("queued-job");
            const job: PendingJob = {
                start: () => _execute(operation, signal, resolve, reject),
                reject,
                signal,
                onAbort: () => _cancel(id, pdfErrors.requestCancelled()),
                deadline: Date.now() + config.pdf.queueTimeoutMs,
            };

            if (activeJobs < config.pdf.concurrency) {
                activeJobs++;
                void job.start();
                return;
            }

            pendingJobs.set(id, job);
            signal.addEventListener("abort", job.onAbort, { once: true });
            job.timer = setTimeout(
                () => _cancel(id, pdfErrors.queueTimeout()),
                config.pdf.queueTimeoutMs,
            );
            if (signal.aborted) job.onAbort();
        });
    },
} as const;

// The slot remains occupied until the operation, including its cleanup, settles.
async function _execute<T>(
    operation: () => Promise<T>,
    signal: AbortSignal,
    resolve: (value: T | PromiseLike<T>) => void,
    reject: (error: unknown) => void,
): Promise<void> {
    try {
        if (signal.aborted) throw pdfErrors.requestCancelled();
        resolve(await operation());
    } catch (error) {
        reject(error);
    } finally {
        activeJobs--;
        _drain();
    }
}

function _drain(): void {
    for (const [id, job] of pendingJobs) {
        if (activeJobs >= config.pdf.concurrency) return;

        pendingJobs.delete(id);
        _dispose(job);

        if (job.signal.aborted) {
            job.reject(pdfErrors.requestCancelled());
        } else if (Date.now() >= job.deadline) {
            job.reject(pdfErrors.queueTimeout());
        } else {
            activeJobs++;
            void job.start();
        }
    }
}

function _cancel(id: symbol, error: Error): void {
    const job = pendingJobs.get(id);
    if (!job) return;

    pendingJobs.delete(id);
    _dispose(job);
    job.reject(error);
}

function _dispose(job: PendingJob): void {
    clearTimeout(job.timer);
    job.signal.removeEventListener("abort", job.onAbort);
}
