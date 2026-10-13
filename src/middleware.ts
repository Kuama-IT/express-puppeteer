import { timingSafeEqual } from "crypto";
import { NextFunction, Request, Response } from "express";
import { PdfQueueError } from "./pdf.queue";

const isValidKey = (provided: string, expected: string): boolean => {
    const providedBuffer = Buffer.from(provided);
    const expectedBuffer = Buffer.from(expected);
    if (providedBuffer.length !== expectedBuffer.length) {
        return false;
    }
    return timingSafeEqual(providedBuffer, expectedBuffer);
};

export const authenticate = (
    req: Request,
    res: Response,
    next: NextFunction,
) => {
    const apiKey = process.env.SECRET_KEY;
    if (!apiKey) {
        return res.status(500).send({ error: "Server misconfigured" });
    }

    const providedKey = req.header("x-api-key");
    if (!providedKey || !isValidKey(providedKey, apiKey)) {
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
    if (err instanceof PdfQueueError) {
        res.status(err.statusCode).send({ error: err.message });
        return;
    }
    console.error(err);
    res.status(500);
    res.send({ error: err });
};
