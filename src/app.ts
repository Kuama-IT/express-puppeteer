import express from "express";
import { config } from "./config";
import { authenticate, errorHandler } from "./middleware";
import { controller } from "./controller";

const app = express();

app.use(express.json({ limit: config.pdf.jsonBodyLimit }));

const router = express.Router();
router.post("/", authenticate, controller.root);

app.use("/api/", router);

app.use(errorHandler);

export default app;
