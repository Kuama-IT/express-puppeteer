import { Response, Request, NextFunction } from "express";
import { pdfGenerationService } from "./pdf-generation.service";

type RequestBody = {
    html: string;
};

export const controller = {
    async root(req: Request, res: Response, next: NextFunction) {
        // Propagate client disconnects to the queue and renderer so abandoned PDFs
        // release their resources. A normally completed response must not abort the job.
        const cancellation = new AbortController();
        const onClose = () => _abortRequest(res, cancellation);
        res.on("close", onClose);
        if (res.destroyed) cancellation.abort();
        try {
            if (typeof (req.body as RequestBody)?.html !== "string") {
                return res.status(400).send("Missing 'html' in request body");
            }

            const pending = pdfGenerationService.generate({
                html: req.body.html,
                signal: cancellation.signal,
            });
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
} as const;

function _abortRequest(
    response: Response,
    cancellation: AbortController,
): void {
    if (!response.writableFinished) cancellation.abort();
}
