import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const _execFile = promisify(execFile);

export function requireDedicatedContainer(): {
    container: string;
    endpoint: URL;
} {
    const container = process.env.TEST_CONTAINER;
    assert.equal(
        container,
        "express-puppeteer",
        "Set TEST_CONTAINER=express-puppeteer only for the dedicated test container.",
    );
    const endpoint = new URL(
        "/api/",
        process.env.TEST_BASE_URL ?? "http://localhost:9000",
    );
    assert.ok(
        _isLoopback(endpoint.hostname),
        "Destructive lifecycle tests require TEST_BASE_URL to target a loopback host.",
    );
    assert.equal(
        endpoint.protocol,
        "http:",
        "Destructive lifecycle tests require a local HTTP service.",
    );
    return { container, endpoint };
}

export async function docker(
    container: string,
    args: string[],
    timeoutMs = 15000,
): Promise<string> {
    assert.ok(
        args.includes(container),
        "Docker operations must explicitly target the validated container.",
    );
    const { stdout } = await _execFile("docker", args, {
        encoding: "utf8",
        timeout: timeoutMs,
    });
    return stdout.trim();
}

export async function assertDedicatedContainer(
    container: string,
): Promise<void> {
    const actualName = await docker(container, [
        "inspect",
        "--format",
        "{{.Name}}",
        container,
    ]);
    assert.equal(
        actualName,
        `/${container}`,
        "Docker resolved a different container than the explicitly named dedicated target.",
    );
}

export async function assertEndpointMapsToContainer(
    container: string,
    endpoint: URL,
): Promise<void> {
    const ports = await docker(container, [
        "inspect",
        "--format",
        "{{json .NetworkSettings.Ports}}",
        container,
    ]);
    const publishedPorts = JSON.parse(ports) as Record<
        string,
        Array<{ HostPort: string }> | null
    >;
    const hostPorts =
        publishedPorts["8080/tcp"]?.map(({ HostPort }) => Number(HostPort)) ??
        [];
    assert.ok(
        hostPorts.includes(Number(endpoint.port || 80)),
        "TEST_BASE_URL port must be published from port 8080 of TEST_CONTAINER.",
    );
    const state = await docker(container, [
        "inspect",
        "--format",
        "{{.State.Status}}",
        container,
    ]);
    assert.equal(
        state,
        "running",
        "The explicitly named lifecycle test container must be running before the destructive action.",
    );
}

function _isLoopback(hostname: string): boolean {
    const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return (
        normalized === "localhost" ||
        normalized === "127.0.0.1" ||
        normalized === "::1"
    );
}
