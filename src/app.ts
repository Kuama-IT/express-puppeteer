import express from "express";
import { authenticate, errorHandler } from "./middleware";
import { controller } from "./controller";

const app = express();

const jsonBodyLimit = process.env.PDF_JSON_BODY_LIMIT ?? "100mb";
app.use(express.json({ limit: jsonBodyLimit }));

const router = express.Router();
router.post("/", authenticate, controller.root);

app.use("/api/", router);

app.use(errorHandler);

export default app;
