type PdfHttpStatusCode = 429 | 503 | 504;

export type PdfHttpError = Error & {
    type: "pdf-http-error";
    statusCode: PdfHttpStatusCode;
};

export const pdfErrors = {
    shuttingDown(): PdfHttpError {
        return _createHttpError("PDF service is shutting down", 503);
    },
    queueFull(): PdfHttpError {
        return _createHttpError("PDF queue is full", 429);
    },
    queueTimeout(): PdfHttpError {
        return _createHttpError("PDF queue wait timed out", 503);
    },
    jobTimeout(): PdfHttpError {
        return _createHttpError("PDF job timed out", 504);
    },
    requestCancelled(): Error {
        return Object.assign(new Error("PDF request cancelled"), {
            name: "PdfRequestCancelledError",
        });
    },
    isHttpError(error: unknown): error is PdfHttpError {
        return (
            error instanceof Error &&
            "type" in error &&
            error.type === "pdf-http-error"
        );
    },
} as const;

function _createHttpError(
    message: string,
    statusCode: PdfHttpStatusCode,
): PdfHttpError {
    return Object.assign(new Error(message), {
        type: "pdf-http-error" as const,
        statusCode,
    });
}
