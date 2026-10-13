import { Page } from "puppeteer";
import { utils } from "./utils";

export const CONTENT_TIMEOUT_MS = utils.parsePositiveInteger(
    process.env.PDF_CONTENT_TIMEOUT_MS,
    360000,
);
export const RENDER_TIMEOUT_MS = utils.parsePositiveInteger(
    process.env.PDF_RENDER_TIMEOUT_MS,
    360000,
);
export const pdfService = {
    render: async (page: Page, html: string): Promise<Buffer> => {
        page.setDefaultTimeout(RENDER_TIMEOUT_MS);
        page.setDefaultNavigationTimeout(CONTENT_TIMEOUT_MS);

        const content = page.setContent(html, {
            waitUntil: "domcontentloaded",
            timeout: CONTENT_TIMEOUT_MS,
        });
        html = "";
        await content;
        await page.emulateMediaType("print");

        // Wait for fonts/images without relying on networkidle0 (too brittle on large docs)
        await page.evaluate(async () => {
            const fontsReady = (
                document as Document & {
                    fonts?: { ready: Promise<unknown> };
                }
            ).fonts?.ready;

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
        });

        const pdf = await page.pdf({
            printBackground: true,
            format: "A4",
        });

        return Buffer.from(pdf);
    },
};
