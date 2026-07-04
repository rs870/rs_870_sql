import { Router } from "express";
import * as db from "../db";
import { generateSql } from "../llm/generateSql";
import { PreviousAttempt } from "../llm/types";
import { classifySql } from "../sqlGuard";
import { listModelsForClient } from "../llm/models";
import { formatErrorResponse } from "./errorResponse";

function operationName(sql: string): string {
  const match = sql.trim().match(/^\s*(INSERT|UPDATE|DELETE)\b/i);
  return match ? match[1].toUpperCase() : "UNKNOWN";
}

export function createAskRouter(): Router {
  const router = Router();

  router.get("/models", (_req, res) => {
    res.json({ models: listModelsForClient() });
  });

  router.get("/analytics", async (_req, res) => {
    try {
      const summary = await db.getAnalyticsSummary();
      res.json(summary);
    } catch (err) {
      res.status(500).json(formatErrorResponse(err));
    }
  });

  router.post("/ask", async (req, res) => {
    const prompt = req.body?.prompt;
    const modelId = req.body?.modelId;
    if (typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({ error: "Body must include a non-empty 'prompt' string." });
    }

    try {
      const tables = await db.listTables();

      let previousAttempt: PreviousAttempt | undefined;
      let lastError: unknown;

      // A generated query can reference a table/column that doesn't
      // actually exist -- give the model one chance to fix it using the
      // real database error before giving up.
      for (let attempt = 0; attempt < 2; attempt++) {
        const generated = await generateSql(prompt, db.dialect, tables, previousAttempt, modelId);
        const classification = classifySql(generated.sql);

        // A real INSERT/UPDATE/DELETE is never auto-executed -- hand it
        // back to the client so it can be re-submitted to /ask/confirm
        // with an admin password.
        if (classification === "modifying-dml") {
          return res.json({
            prompt,
            sql: generated.sql,
            explanation: generated.explanation,
            requiresConfirmation: true,
            operation: operationName(generated.sql),
          });
        }

        try {
          const data = await db.executeReadOnlyQuery(generated.sql);
          return res.json({
            prompt,
            sql: generated.sql,
            explanation: generated.explanation,
            ...data,
          });
        } catch (err) {
          lastError = err;
          previousAttempt = {
            sql: generated.sql,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }

      throw lastError instanceof Error ? lastError : new Error("Query execution failed.");
    } catch (err) {
      res.status(500).json(formatErrorResponse(err));
    }
  });

  router.post("/ask/confirm", async (req, res) => {
    const { sql, adminPassword } = req.body ?? {};
    if (typeof sql !== "string" || !sql.trim()) {
      return res.status(400).json({ error: "Body must include the 'sql' to confirm." });
    }

    const configuredPassword = process.env.ADMIN_PASSWORD;
    if (!configuredPassword) {
      return res.status(503).json({
        error: "Destructive-query confirmation is disabled: set ADMIN_PASSWORD in .env to enable it.",
      });
    }
    if (typeof adminPassword !== "string" || adminPassword !== configuredPassword) {
      return res.status(401).json({ error: "Incorrect admin password." });
    }

    try {
      const data = await db.executeConfirmedWrite(sql);
      res.json({ sql, ...data });
    } catch (err) {
      res.status(500).json(formatErrorResponse(err));
    }
  });

  return router;
}
