import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

test(
    "generates a readable one-page PDF containing the supplied HTML text",
    {
        timeout: 45000,
    },
    async () => {
        const secretKey = process.env.SECRET_KEY;
        assert.ok(
            secretKey,
            "Set SECRET_KEY to the API key used by the running service.",
        );

        // TEST_BASE_URL is the service origin; the API route is always /api/.
        const endpoint = new URL(
            "/api/",
            process.env.TEST_BASE_URL ?? "http://localhost:9000",
        );
        const html = await readFile(
            new URL("../fixtures/simple.html", import.meta.url),
            "utf8",
        );
        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": secretKey,
            },
            body: JSON.stringify({ html }),
            signal: AbortSignal.timeout(30000),
        });

        assert.equal(
            response.status,
            200,
            "PDF generation should return HTTP 200.",
        );
        assert.match(
            response.headers.get("content-type") ?? "",
            /^application\/pdf(?:;|$)/i,
        );
        assert.equal(
            response.headers.get("content-disposition"),
            'attachment; filename="file.pdf"',
        );

        const bytes = new Uint8Array(await response.arrayBuffer());
        assert.equal(
            Buffer.from(bytes.subarray(0, 5)).toString("ascii"),
            "%PDF-",
        );

        // Parse the actual document: a PDF header alone does not prove it is readable.
        const loadingTask = getDocument({ data: bytes });
        try {
            const pdf = await loadingTask.promise;
            assert.equal(pdf.numPages, 1);

            const page = await pdf.getPage(1);
            const content = await page.getTextContent();
            const text = content.items
                .filter((item) => "str" in item)
                .map((item) => item.str)
                .join(" ")
                .replace(/\s+/g, " ");

            assert.ok(
                text.includes("PDF integration check"),
                "The PDF must contain the HTML heading.",
            );
            assert.ok(
                text.includes("Reference: PDF-001"),
                "The PDF must contain the HTML body text.",
            );
        } finally {
            await loadingTask.destroy();
        }
    },
);
