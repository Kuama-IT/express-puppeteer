type Release = () => void;

const parsePositiveInteger = (value: string | undefined, fallback: number) => {
    const parsed = Number.parseInt(value ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const maxConcurrency = parsePositiveInteger(
    process.env.PDF_MAX_CONCURRENCY,
    2,
);
const maxQueueSize = parsePositiveInteger(process.env.PDF_MAX_QUEUE_SIZE, 20);

let activeRequests = 0;
const queue: Array<(release: Release) => void> = [];

const createRelease = (): Release => {
    let released = false;

    return () => {
        if (released) {
            return;
        }

        released = true;
        activeRequests -= 1;

        const next = queue.shift();
        if (next) {
            activeRequests += 1;
            next(createRelease());
        }
    };
};

export const acquirePdfSlot = async (): Promise<Release | undefined> => {
    if (activeRequests < maxConcurrency) {
        activeRequests += 1;
        return createRelease();
    }

    if (queue.length >= maxQueueSize) {
        return undefined;
    }

    return new Promise<Release>((resolve) => {
        queue.push(resolve);
    });
};
