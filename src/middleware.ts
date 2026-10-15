import { timingSafeEqual } from "crypto";
import { NextFunction, Request, Response } from "express";
import { config } from "./config";
import { pdfErrors } from "./pdf-errors";

export const authenticate = (
    req: Request,
    res: Response,
    next: NextFunction,
) => {
    const providedKey = req.header("x-api-key");
    if (!providedKey || !_isValidKey(providedKey, config.secretKey)) {
        return res.status(401).send({ error: "Invalid or missing API key" });
    }

    next();
};

export const errorHandler = (
    err: Error,
    _req: Request,
    res: Response,
    next: NextFunction,
) => {
    if (res.headersSent) {
        return next(err);
    }
    if (pdfErrors.isHttpError(err)) {
        res.status(err.statusCode).send({ error: err.message });
        return;
    }
    console.error(err);
    res.status(500);
    res.send({ error: err });
};

function _isValidKey(provided: string, expected: string): boolean {
    const providedBuffer = Buffer.from(provided);
    const expectedBuffer = Buffer.from(expected);
    if (providedBuffer.length !== expectedBuffer.length) {
        return false;
    }
    return timingSafeEqual(providedBuffer, expectedBuffer);
}
