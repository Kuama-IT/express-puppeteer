const { join } = require("path");

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
    // install puppeteer dependencies in the current folder directory
    cacheDirectory: join(__dirname, ".cache", "puppeteer"),
    chrome: {
        skipDownload: false,
    },
};
