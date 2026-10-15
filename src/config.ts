import { z } from "zod";

const positiveInteger = z.coerce.number().int().positive();
const nonNegativeInteger = z.coerce.number().int().nonnegative();

const envSchema = z.object({
    SECRET_KEY: z.string().min(1),
    PDF_CONCURRENCY: positiveInteger.default(1),
    PDF_MAX_PENDING: nonNegativeInteger.default(2),
    PDF_QUEUE_TIMEOUT_MS: positiveInteger.default(30000),
    PROTOCOL_TIMEOUT_MS: positiveInteger.default(180000),
    PDF_CONTENT_TIMEOUT_MS: positiveInteger.default(240000),
    PDF_RENDER_TIMEOUT_MS: positiveInteger.default(180000),
    PDF_JOB_TIMEOUT_MS: positiveInteger.default(480000),
    SHUTDOWN_DRAIN_TIMEOUT_MS: positiveInteger.default(10000),
    SHUTDOWN_CLEANUP_TIMEOUT_MS: positiveInteger.default(45000),
    PDF_JSON_BODY_LIMIT: z
        .string()
        .regex(/^\d+(?:\.\d+)?(?:kb|mb|gb)$/i)
        .default("25mb"),
});

const env = envSchema.parse(process.env);

export const config = {
    secretKey: env.SECRET_KEY,
    shutdown: {
        drainTimeoutMs: env.SHUTDOWN_DRAIN_TIMEOUT_MS,
        cleanupTimeoutMs: env.SHUTDOWN_CLEANUP_TIMEOUT_MS,
    },
    pdf: {
        concurrency: env.PDF_CONCURRENCY,
        maxPending: env.PDF_MAX_PENDING,
        queueTimeoutMs: env.PDF_QUEUE_TIMEOUT_MS,
        protocolTimeoutMs: env.PROTOCOL_TIMEOUT_MS,
        contentTimeoutMs: env.PDF_CONTENT_TIMEOUT_MS,
        renderTimeoutMs: env.PDF_RENDER_TIMEOUT_MS,
        jobTimeoutMs: env.PDF_JOB_TIMEOUT_MS,
        jsonBodyLimit: env.PDF_JSON_BODY_LIMIT,
        cleanupTimeoutMs: Math.min(env.PROTOCOL_TIMEOUT_MS, 10000),
    },
} as const;
