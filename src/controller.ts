import { Response, Request } from "express";

export const root = (_req: Request, res: Response) => {
    return res.send("Hello World");
};
