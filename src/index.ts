import "dotenv/config";
import path from "path";
import express from "express";
import { createAskRouter } from "./routes/ask";

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));
app.use(createAskRouter());

app.get("/health", (_req, res) => res.json({ ok: true }));

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`nl2sql-server listening on :${port}`));
