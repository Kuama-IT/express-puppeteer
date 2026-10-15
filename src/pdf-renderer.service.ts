import { Page } from "puppeteer";
import { config } from "./config";

export const pdfRendererService = {
    async render(page: Page, html: string): Promise<Buffer> {
        page.setDefaultTimeout(config.pdf.renderTimeoutMs);
        page.setDefaultNavigationTimeout(config.pdf.contentTimeoutMs);

        await page.setContent(html, {
            waitUntil: "domcontentloaded",
            timeout: config.pdf.contentTimeoutMs,
        });
        await page.emulateMediaType("print");

        // This callback runs in Chrome and cannot access helpers from this Node module.
        // Keep the font/image waiting logic self-contained inside evaluate().
        await page.evaluate(async () => {
            await document.fonts.ready;

            const pendingImages = Array.from(document.images).filter(
                (image) => !image.complete,
            );
            await Promise.allSettled(
                pendingImages.map(
                    (image) =>
                        new Promise<void>((resolve) => {
                            image.addEventListener("load", () => resolve(), {
                                once: true,
                            });
                            image.addEventListener("error", () => resolve(), {
                                once: true,
                            });
                        }),
                ),
            );
        });

        const pdf = await page.pdf({
            printBackground: true,
            format: "A4",
        });
        return Buffer.from(pdf);
    },
} as const;
