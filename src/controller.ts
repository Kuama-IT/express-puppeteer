import { Response, Request, NextFunction } from "express";
import puppeteer from "puppeteer";

type RequestBody = {
    html: string;
};

const CONTENT_TIMEOUT_MS = Number.parseInt(
    process.env.PDF_CONTENT_TIMEOUT_MS ?? "240000",
    10,
);
const RENDER_TIMEOUT_MS = Number.parseInt(
    process.env.PDF_RENDER_TIMEOUT_MS ?? "240000",
    10,
);

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
        page.setDefaultTimeout(RENDER_TIMEOUT_MS);
        page.setDefaultNavigationTimeout(CONTENT_TIMEOUT_MS);

        await page.setContent(requestBody.html, {
            waitUntil: "domcontentloaded",
            timeout: CONTENT_TIMEOUT_MS,
        });

        // Wait for fonts/images without relying on networkidle0 (too brittle on large docs)
        await page
            .evaluate(async () => {
                const fontsReady = (document as Document & {
                    fonts?: { ready: Promise<unknown> };
                }).fonts?.ready;

                if (fontsReady) {
                    await fontsReady.catch(() => undefined);
                }

                const images = Array.from(document.images);
                await Promise.allSettled(
                    images.map(async (img) => {
                        if (img.complete) {
                            return;
                        }
                        await new Promise<void>((resolve) => {
                            img.addEventListener("load", () => resolve(), {
                                once: true,
                            });
                            img.addEventListener("error", () => resolve(), {
                                once: true,
                            });
                        });
                    }),
                );
            })
            .catch(() => undefined);

        const pdfStream = await page.createPDFStream({
            printBackground: true,
            format: "A4",
        });

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

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", 'attachment; filename="file.pdf"');
        return res.send(buffer);
    } catch (error) {
        next(error);
    } finally {
        await browser.close();
    }
};
