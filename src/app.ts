import express from "express";
import { errorHandler } from "./middleware";
import { root } from "./controller";

const app = express();

app.use(express.json({ limit: "5MB" }));

const router = express.Router();
router.post("/", root);

app.use("/api/", router);

app.use(errorHandler);

export default app;
