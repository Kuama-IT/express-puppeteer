import "dotenv/config";
import app from "./app";
import { browserManagerService } from "./browser-manager.service";
import { pdfGenerationService } from "./pdf-generation.service";
import { config } from "./config";

const server = app.listen(8080, () => {
    console.log(`Server running on port ${8080}`);
});

let shuttingDown = false;

// Deployment requirement: enable Docker --init in Coolify to reap orphaned Chrome
// child processes. Application shutdown alone cannot prevent zombie accumulation.
process.once("SIGTERM", () => void _shutdown());
process.once("SIGINT", () => void _shutdown());
process.once("SIGHUP", () => void _shutdown());

async function _shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    pdfGenerationService.stopAccepting();
    const closed = new Promise<void>((resolve) =>
        server.close(() => resolve()),
    );
    let browserCleanup: Promise<void> | undefined;
    const drainTimer = setTimeout(() => {
        pdfGenerationService.cancelAll();
        browserCleanup = browserManagerService.shutdown();
        // Observe rejection immediately, even if an HTTP connection still hangs.
        void browserCleanup.catch((error) =>
            console.error("Browser shutdown failed", error),
        );
    }, config.shutdown.drainTimeoutMs);
    // Leave time for context/browser cleanup after cancellation. If dependencies
    // never settle, exit nonzero before the deployment's termination grace expires.
    const hardDeadline = setTimeout(() => {
        console.error("Shutdown cleanup deadline exceeded");
        server.closeAllConnections();
        process.exit(1);
    }, config.shutdown.drainTimeoutMs + config.shutdown.cleanupTimeoutMs);
    try {
        await closed;
        await (browserCleanup ?? browserManagerService.shutdown());
    } catch (error) {
        console.error("Shutdown failed", error);
        process.exitCode = 1;
    } finally {
        clearTimeout(drainTimer);
        clearTimeout(hardDeadline);
    }
}
