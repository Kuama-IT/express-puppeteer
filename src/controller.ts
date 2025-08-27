import { Response, Request, NextFunction } from "express";
import puppeteer from "puppeteer";

type RequestBody = {
    html: string;
};

export const root = async (req: Request, res: Response, next: NextFunction) => {
    const browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    try {
        const requestBody = req.body as RequestBody;
        if (requestBody?.html === undefined) {
            return res.status(400).send("Missing 'html' in request body");
        }

        const page = await browser.newPage();

        await page.setContent(requestBody.html);

        const pdfStream = await page.createPDFStream();

        async function streamToBuffer(
            stream: ReadableStream<Uint8Array>,
        ): Promise<Buffer> {
            const reader = stream.getReader();
            const chunks: Uint8Array[] = [];
            let result = await reader.read();
            while (!result.done) {
                chunks.push(result.value);
                result = await reader.read();
            }
            return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
        }

        const buffer = await streamToBuffer(pdfStream);
        await browser.close();
        res.setHeader("Content-Type", "application/pdf"); // or the correct MIME type
        res.setHeader("Content-Disposition", 'attachment; filename="file.pdf"');
        return res.send(buffer);
    } catch (error) {
        next(error);
    } finally {
        await browser.close();
    }
};
