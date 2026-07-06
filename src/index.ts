import "dotenv/config";
import path from "path";
import express from "express";
import cors from "cors";
import { createAskRouter } from "./routes/ask";

const app = express();

// IRASS (or any other browser-based client) is a separate frontend hosted
// on its own origin -- without CORS headers the browser blocks the
// response even though the request itself succeeds. ALLOWED_ORIGIN
// defaults to "*" to keep the prototype easy to point anywhere; set it to
// IRASS's real origin once known to stop accepting requests from others.
app.use(cors({ origin: process.env.ALLOWED_ORIGIN ?? "*" }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));
app.use(createAskRouter());

app.get("/health", (_req, res) => res.json({ ok: true }));

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`nl2sql-server listening on :${port}`));
