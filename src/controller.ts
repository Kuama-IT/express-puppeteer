import { Response, Request, NextFunction } from "express";
import { pdfOrchestrator } from "./pdf.orchestrator";

type RequestBody = {
    html: string;
};

export const controller = {
    root: async (req: Request, res: Response, next: NextFunction) => {
        const cancellation = new AbortController();
        const onClose = () => {
            if (!res.writableFinished) cancellation.abort();
        };
        res.on("close", onClose);
        if (res.destroyed) cancellation.abort();
        try {
            if (typeof (req.body as RequestBody)?.html !== "string") {
                return res.status(400).send("Missing 'html' in request body");
            }

            const pending = pdfOrchestrator.generate(
                req.body.html,
                cancellation.signal,
            );
            // The orchestrator owns the HTML; release the parsed body from the request.
            req.body = undefined;
            const pdf = await pending;
            if (cancellation.signal.aborted || res.destroyed) return;
            res.setHeader("Content-Type", "application/pdf");
            res.setHeader(
                "Content-Disposition",
                'attachment; filename="file.pdf"',
            );
            return res.send(pdf);
        } catch (err) {
            if (!cancellation.signal.aborted && !res.destroyed) next(err);
        } finally {
            req.body = undefined;
            res.removeListener("close", onClose);
        }
    },
};
