# Express puppeteer

This is a standalone puppeteer server which transforms pure HTML DOM to a PDF.
The server is built with expressjs and node and can be launched with docker.

## Run with docker

The docker image can be built and run with docker compose.

```
docker compose build
```

or

```
docker compose up -d
```

## Run locally

The expressjs server can be launched locally, for development or testing, using:

```
npm i
npm run dev
```
