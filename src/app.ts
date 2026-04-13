import express from "express";
import { errorHandler } from "./middleware";
import { root } from "./controller";

const app = express();

const jsonBodyLimit = process.env.PDF_JSON_BODY_LIMIT ?? "100mb";
app.use(express.json({ limit: jsonBodyLimit }));

const router = express.Router();
router.post("/", root);

app.use("/api/", router);

app.use(errorHandler);

export default app;
