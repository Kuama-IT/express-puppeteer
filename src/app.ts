import express from "express";
import { errorHandler } from "./middleware";
import { root } from "./controller";

const app = express();

app.use(express.json());

const router = express.Router();
router.get("/", root);

app.use("/api/", router);

app.use(errorHandler);

export default app;
