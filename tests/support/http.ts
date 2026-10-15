import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import assert from "node:assert/strict";

export type _HeldImage = {
    imageUrl: URL;
    requested: Promise<void>;
    release: () => void;
    close: () => Promise<void>;
};

export async function _holdImage(): Promise<_HeldImage> {
    const imagePath = `/blocked-${randomUUID()}.svg`;
    const imageRequested = Promise.withResolvers<void>();
    let imageResponse: ServerResponse | undefined;
    const server = createServer((request, response) => {
        if (request.url !== imagePath) {
            response.writeHead(404).end();
            return;
        }
        imageResponse = response;
        response.writeHead(200, {
            "Content-Type": "image/svg+xml",
            "Cache-Control": "no-store",
        });
        response.flushHeaders();
        imageRequested.resolve();
    });

    server.listen(0, "0.0.0.0");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        throw new Error("The image fixture did not receive a TCP address.");
    }

    const assetHost = process.env.TEST_ASSET_HOST ?? "host.docker.internal";
    const imageUrl = new URL(imagePath, `http://${assetHost}:${address.port}`);

    return {
        imageUrl,
        requested: imageRequested.promise,
        release: () => {
            if (
                !imageResponse ||
                imageResponse.writableEnded ||
                imageResponse.destroyed
            )
                return;
            imageResponse.end(
                '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>',
            );
        },
        close: async () => {
            imageResponse?.destroy();
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

export function _generate(
    endpoint: URL,
    secretKey: string,
    html: string,
    signal: AbortSignal,
): Promise<Response> {
    return fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": secretKey },
        body: JSON.stringify({ html }),
        signal,
    });
}

export function _track(
    requests: Promise<Response>[],
    request: Promise<Response>,
): Promise<Response> {
    requests.push(request);
    void request.catch(() => {});
    return request;
}

export async function _assertPdf(response: Response): Promise<void> {
    assert.equal(response.status, 200);
    assert.match(
        response.headers.get("content-type") ?? "",
        /^application\/pdf(?:;|$)/i,
    );
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.subarray(0, 5).toString("ascii"), "%PDF-");
}
