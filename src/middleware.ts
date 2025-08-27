import { NextFunction, Request, Response } from "express";

export const errorHandler = (
    err: Error,
    _req: Request,
    res: Response,
    next: NextFunction,
) => {
    if (res.headersSent) {
        return next(err);
    }
    console.error(err);
    res.status(500);
    res.send({ error: err });
};
