import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import puppeteer from "puppeteer";
import { Browser, BrowserPlatform, getDownloadUrl } from "@puppeteer/browsers";

// Build-only workaround for the CLI exiting without a complete Chrome extraction.
// Use native ZIP extraction, but retain Puppeteer's pinned version and cache path.
if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error(
        "This image requires linux/amd64. Build with DOCKER_DEFAULT_PLATFORM=linux/amd64.",
    );
}

const version =
    puppeteer.configuration.chrome?.version ?? puppeteer.defaultBrowserRevision;
const url = getDownloadUrl(Browser.CHROME, BrowserPlatform.LINUX, version);
const executable = puppeteer.executablePath();
const installationDirectory = dirname(dirname(executable));
const temporaryDirectory = mkdtempSync(join(tmpdir(), "pdf-chrome-install-"));
const archive = join(temporaryDirectory, "chrome.zip");

try {
    console.log(`Installing Chrome ${version} into ${installationDirectory}`);
    execFileSync(
        "curl",
        [
            "--fail",
            "--location",
            "--show-error",
            "--retry",
            "3",
            "--connect-timeout",
            "30",
            "--max-time",
            "600",
            "--output",
            archive,
            url.toString(),
        ],
        { stdio: "inherit" },
    );
    mkdirSync(installationDirectory, { recursive: true });
    execFileSync("unzip", ["-q", "-o", archive, "-d", installationDirectory], {
        stdio: "inherit",
    });
    accessSync(executable, constants.X_OK);
    execFileSync(executable, ["--version"], {
        stdio: "inherit",
        timeout: 30000,
    });
} finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
}
