FROM node:26

WORKDIR /app

# Cache system libraries independently of application dependencies and source.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
        libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
        libgbm1 libasound2 curl unzip \
    && rm -rf /var/lib/apt/lists/*

# Load Puppeteer's configuration before installing Chrome into /app/.cache.
COPY package.json package-lock.json .puppeteerrc.cjs ./
# Download the browser only in the explicit installation step below.
RUN PUPPETEER_SKIP_DOWNLOAD=true npm ci
COPY scripts/install-chrome.mjs ./scripts/install-chrome.mjs
RUN node scripts/install-chrome.mjs

COPY . .
RUN npm run build

CMD ["node","dist/server.js"]
