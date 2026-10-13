export class PdfQueueError extends Error {
    constructor(
        message: string,
        readonly statusCode: 429 | 503,
    ) {
        super(message);
    }
}

export const requestCancelled = (): Error => new Error("PDF request cancelled");

type PendingJob = {
    start: () => void;
    reject: (error: Error) => void;
    cleanup: () => void;
    deadline: number;
};

// Own the waiting list so cancelled jobs release their HTML immediately.
export class PdfQueue {
    private active = 0;
    private readonly pending: PendingJob[] = [];

    constructor(
        private readonly concurrency: number,
        private readonly maxPending: number,
        private readonly waitTimeout: number,
    ) {}

    run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        if (signal?.aborted) return Promise.reject(requestCancelled());
        if (
            this.active >= this.concurrency &&
            this.pending.length >= this.maxPending
        ) {
            return Promise.reject(new PdfQueueError("PDF queue is full", 429));
        }

        return new Promise<T>((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const remove = (error: Error) => {
                const index = this.pending.indexOf(entry);
                if (index === -1) return;
                this.pending.splice(index, 1);
                entry.cleanup();
                reject(error);
            };
            const onAbort = () => remove(requestCancelled());
            const entry: PendingJob = {
                deadline: Date.now() + this.waitTimeout,
                reject,
                cleanup: () => {
                    clearTimeout(timer);
                    signal?.removeEventListener("abort", onAbort);
                },
                start: () => {
                    entry.cleanup();
                    this.active++;
                    void Promise.resolve()
                        .then(() => {
                            if (signal?.aborted) throw requestCancelled();
                            return operation();
                        })
                        .then(
                            (value) => {
                                this.active--;
                                this.drain();
                                resolve(value);
                            },
                            (error) => {
                                this.active--;
                                this.drain();
                                reject(error);
                            },
                        );
                },
            };

            if (this.active < this.concurrency) {
                entry.start();
            } else {
                this.pending.push(entry);
                signal?.addEventListener("abort", onAbort, { once: true });
                timer = setTimeout(
                    () =>
                        remove(
                            new PdfQueueError("PDF queue wait timed out", 503),
                        ),
                    this.waitTimeout,
                );
            }
        });
    }

    private drain(): void {
        while (this.active < this.concurrency && this.pending.length > 0) {
            const entry = this.pending.shift()!;
            if (Date.now() >= entry.deadline) {
                entry.cleanup();
                entry.reject(
                    new PdfQueueError("PDF queue wait timed out", 503),
                );
            } else {
                entry.start();
            }
        }
    }
}
