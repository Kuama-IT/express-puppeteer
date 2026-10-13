export const utils = {
    withTimeout: async <T>(
        operation: Promise<T>,
        milliseconds: number,
        message: string,
    ): Promise<T> => {
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
    },

    parseNonNegativeInteger: (value: string | undefined, fallback: number) => {
        if (value === undefined || !/^\d+$/.test(value)) return fallback;
        const parsed = Number(value);
        return Number.isSafeInteger(parsed) ? parsed : fallback;
    },
    parsePositiveInteger: (value: string | undefined, fallback: number) => {
        if (value === undefined) {
            return fallback;
        }

        const parsed = Number(value);
        return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
    },
};
