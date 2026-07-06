# NL2SQL Server — Project Writeup

## What this project does

Answering a question like "how many employees joined this year?" normally
requires knowing SQL and the database's schema. This project removes that
requirement: a user types a plain-English question into a web page, and the
server translates it into SQL, checks that it's safe, runs it against the
real database, and returns the results.

The pipeline can run **fully offline** — the default model is hosted
locally via [Ollama](https://ollama.com), no API key, no account, no
internet connection required. It can also be pointed at a bigger model
running on dedicated hardware (see "Model selection" below); either way,
nothing outside the two servers you configure is ever contacted.

## Architecture

```
Browser (public/index.html)
   |  GET /models                 -> populates the model dropdown
   |  POST /ask { prompt, modelId }
   v
Express route (src/routes/ask.ts)
   |
   |-- db.listTables()          src/db.ts
   |     introspects the real Postgres schema (information_schema)
   |
   |-- Step 1: schema relevance filtering   src/llm/schemaFilter.ts
   |     scores each table by keyword overlap with the question and keeps
   |     only the top ~20 (out of 173) -- see "Why this is its own step"
   |
   |-- Step 2: generateSql()    src/llm/generateSql.ts
   |     builds the prompt (src/llm/promptBuilder.ts) from the filtered
   |     schema, sends it to whichever model backend was selected --
   |     local Ollama (src/llm/providers/ollamaProvider.ts) or a
   |     self-hosted OpenAI-compatible server (src/llm/providers/
   |     openAiCompatProvider.ts) -- and asks for
   |     { "sql": "...", "explanation": "..." } as strict JSON.
   |     extractJson() (src/llm/jsonExtract.ts) is a defensive fallback
   |     regardless of which backend answered.
   |
   |-- Step 3: classifySql()    src/sqlGuard.ts
   |     this is the actual trust boundary -- the model only ever
   |     *proposes* SQL, this layer decides what happens to it:
   |       - a plain SELECT/WITH runs immediately, read-only
   |       - an INSERT/UPDATE/DELETE is never auto-run -- the response
   |         comes back with requiresConfirmation: true and waits for an
   |         admin password at POST /ask/confirm
   |       - DDL (DROP/ALTER/TRUNCATE/...) and multi-statement SQL are
   |         rejected outright, no password can unlock those
   |
   |-- db.executeReadOnlyQuery()  src/db.ts
   |     runs inside `BEGIN TRANSACTION READ ONLY ... ROLLBACK` so nothing
   |     can be written even if a check upstream is somehow bypassed
   |     - if this fails (e.g. an invented table name), the real error is
   |       fed back to generateSql() for one self-correction retry
   v
JSON response: { sql, explanation, columns, rows, rowCount }
   |            (or { requiresConfirmation, sql, explanation, operation }
   |             for a modifying query, or { error, technicalError } on
   |             failure -- see "Error reporting" below)
   v
Browser renders a table, or a password-confirmation box, or the raw
technical error
```

## Step 1: schema relevance filtering (the highest-leverage piece of this pipeline)

Ollama defaults to a small context window (2048 tokens) regardless of the
model's real capacity. This database has 173 tables and ~2,200 columns —
far too much to fit in that window, and increasing it isn't free: this
machine has ~8GB RAM with little free, and a larger context window costs
proportionally more memory for the model's KV cache.

Early testing tried truncating the schema blindly to fit, and the model
promptly invented a table that didn't exist because the real one had been
cut. `src/llm/schemaFilter.ts` fixes that by scoring every table against
the question and keeping only the top matches (`OLLAMA_MAX_TABLES`, default
20). It's the single change that made the rest of the pipeline reliable —
worth calling out on its own rather than leaving buried inside a model
provider file, since it's what a bigger hosted model would eventually let
us relax, not something inherent to "translating English to SQL."

Two scoring strategies live side by side:

- **Keyword overlap** (`selectRelevantTablesKeyword`) — tokenizes the
  question and every table/column name, scores by overlap. Zero
  dependencies, works with any backend, but only catches matches that
  share literal words (e.g. a question about "staff" won't score
  `employee_master` at all).
- **Semantic/vector similarity** (`selectRelevantTablesSemantic`) — used
  automatically when the Gemma/H200 backend is selected. Each table is
  turned into a short text (`schema.table columns: ...`), embedded via the
  H200 box's `/v1/embeddings` endpoint, and ranked against the question's
  embedding by cosine similarity — so "staff" and "employee" match even
  without sharing a token. Table embeddings are computed once and cached
  in memory (the schema doesn't change at runtime); only the question is
  embedded per request. If the embeddings call fails for any reason
  (endpoint unreachable, model doesn't expose embeddings), it's logged and
  the pipeline falls straight back to keyword scoring rather than failing
  the request — schema filtering degrades, it never blocks SQL generation.

## Model selection

`/ask` accepts an optional `modelId`; the web UI exposes it as a dropdown
populated from `GET /models`. Two backends are wired up today
(`src/llm/models.ts`):

- `qwen2.5-coder-7b` — the original local, offline setup: Ollama running on
  this machine, `qwen2.5-coder:7b`, ~40s per question on CPU-only hardware.
- `gemma-3-27b` — Gemma 3 27B on a dedicated H200 GPU, served behind an
  OpenAI-compatible API on port 3001. Bigger model, real GPU, noticeably
  faster and better at picking the right table even before schema
  filtering narrows things down.

Both backends go through the exact same schema-filtering step and the same
JSON parsing/validation (`src/llm/generateSql.ts` dispatches; the two
providers only differ in the HTTP call). Adding a third backend means
adding one entry to `models.ts` and, if it doesn't speak Ollama's or
OpenAI's chat format, one small provider file.

A caller can also select by size instead of by name — `paramsB: 7` or
`paramsB: 27` resolves to the matching entry above via `getModelConfig()`.
This exists for machine callers (see "Database selection and the API
contract" below) that want to say "give me the bigger model" without
knowing its id; `modelId` wins if both are supplied.

## Database selection and the API contract

`/ask` was originally hardcoded to a single Postgres connection. It's now a
selector, same shape as the model picker: `POST /ask` accepts `database`,
resolved against a registry in `src/databases.ts` (`GET /databases` lists
the options). Each database gets its own lazily-created, cached connection
pool (`src/db.ts`) instead of one global pool, so adding a database is a
config change, not a code change.

Only `nextgendb` is actually wired up to real connection details today.
`db2-placeholder` exists in the registry with empty host/database fields —
selecting it returns a clear "not configured" error rather than a raw
connection failure, and it becomes usable the moment its `DB2_*` env vars
(`.env.example`) are filled in.

This is what makes `/ask` usable as a plain JSON API for another
application (not just the browser UI) to call directly:

```
POST /ask
{ "prompt": "...", "database": "nextgendb", "modelId": "gemma-3-27b" }
  -- or, selecting by size instead of name --
{ "prompt": "...", "database": "nextgendb", "paramsB": 27 }

-> 200 { prompt, database, modelId, sql, explanation, columns, rows, rowCount }
-> 200 { prompt, database, modelId, sql, explanation, requiresConfirmation: true, operation }
-> 500 { error, technicalError }
```

The response always echoes back the `database` and the *resolved*
`modelId` (even when the caller specified `paramsB` instead), so a
programmatic caller always knows exactly what ran. `POST /ask/confirm`
takes the same `database` field so a confirmed write lands in the same
database the original question was run against. There's deliberately no
new endpoint for this — `/ask` serves both the web UI and any external
caller with the same contract, so there's only one code path to keep
correct.

## Confirming a destructive query

The model is allowed to propose an INSERT/UPDATE/DELETE — plenty of
reasonable questions ("mark this employee inactive", "add an award record")
require one — but it's never executed on the strength of the model alone.
`classifySql()` routes it to a hold state instead of running it:

1. `/ask` returns `{ sql, explanation, requiresConfirmation: true,
operation: "DELETE" }` without touching the database.
2. The UI shows the exact SQL and asks for an admin password.
3. That password, plus the *same* SQL (not a re-generated one), goes to
   `POST /ask/confirm`.
4. The server checks the password against `ADMIN_PASSWORD` in `.env`
   (blank by default — the whole feature is off until someone sets it),
   re-validates the SQL server-side (`assertConfirmedDml()` — still refuses
   DDL and multi-statement SQL even with a correct password), and only
   then runs it in a real, committed transaction (`db.executeConfirmedWrite()`).

Schema-altering statements (DROP/ALTER/TRUNCATE/CREATE/GRANT/REVOKE/...)
never reach this path at all — no password confirms those, by design.

## Error reporting

Every error response includes two fields: `error`, a short message, and
`technicalError`, the full plaintext detail — exception class, message, and
(for Postgres errors) the error code/detail/hint/position when present.
The web UI renders both: the short message up top, the technical detail in
a monospace block below it. The point is to make failures debuggable during
a demo instead of staring at a generic "Internal Server Error."

## How to run it

```
cd nl2sql-server
npm install
cp .env.example .env   # fill in PG_*, GEMMA_BASE_URL, ADMIN_PASSWORD
npm run dev             # or: npm run build && npm start
```

Requires Ollama installed with `qwen2.5-coder:7b` pulled and `ollama serve`
running (starts automatically after install on Windows):

```
winget install Ollama.Ollama
ollama pull qwen2.5-coder:7b    # ~4.7GB, one-time download
```

If the Gemma 3 27B backend is in play, `GEMMA_BASE_URL` needs to point at
the actual H200 host — `localhost:3001` only works if that port is
tunneled/forwarded to this machine.

Then either:
- Open `http://localhost:3000/` in a browser for the web form, or
- `curl -X POST http://localhost:3000/ask -H "Content-Type: application/json" -d '{"prompt": "List the 10 most recently added employees"}'`

The Postgres instance backing this demo is a portable (non-installed)
PostgreSQL at `C:\Users\arpit\pgportable`, listening on port 5433, with the
restored `nextgendb` HRMS backup (173 tables, 1,081 real employee rows). If
it's not running:

```
C:\Users\arpit\pgportable\pgsql\bin\pg_ctl.exe -D C:\Users\arpit\pgportable\data -l C:\Users\arpit\pgportable\server.log -o "-p 5433" start
```

## What's proven to work

Verified directly against the running system, full round trip:

- Schema introspection (`db.listTables()`) correctly reads all 173 tables
  across the `pers`, `digitalsig`, `request`, `training`, and `utility`
  schemas.
- A complete, successful `/ask` round trip — English question in, generated
  SQL, real rows out — confirmed live, e.g.:
  - *"List the 5 most recently added employees"* → generated and ran
    `SELECT name FROM pers.employee_master ORDER BY date_of_joining_org DESC
    LIMIT 5` → 5 real employee names returned.
  - *"How many employees are there in total?"* → generated and ran
    `SELECT COUNT(*) ... WHERE is_active = true` → `965`.
- The self-correction retry works as designed: an early test had the model
  invent a nonexistent table; the real Postgres error was fed back and the
  next attempt used the correct table.
- The safety guard rejects a `DELETE` statement before it ever reaches the
  database, and routes it to the confirmation flow instead when submitted
  through `/ask`.
- The Express server boots, `/health` responds, and the web form at `/` is
  served and submits to `/ask` correctly.
- Confirmed nothing in the dependency tree or runtime calls any external
  API — `@anthropic-ai/sdk` was removed entirely; the only network calls
  `generateSql()` makes are to `localhost:11434` (Ollama) or the configured
  `GEMMA_BASE_URL`.

## Deliberate scope decisions (not gaps)

This version intentionally does **not** support multiple/federated data
sources — an earlier iteration had a `DataSource` interface and router
designed for that, but since only one Postgres database is actually in use,
that abstraction was removed in favor of a direct, simpler `src/db.ts`
module. Re-introducing an interface layer would be straightforward if a
second data source is ever actually needed, but there's no value in
carrying that complexity for one database.

Also out of scope, as a deliberate choice for a prototype/demo rather than
an oversight: no auth on `/ask` itself (only the confirm step is
password-gated), no per-role table allow-list, and the Postgres role used
has more than `SELECT`/write privilege at the database level (the app-level
guard is the only enforcement right now). See the Security notes in
`README.md`.

## Testing

`sqlGuard.ts` has unit tests (`src/sqlGuard.test.ts`) covering: rejecting
multi-statement SQL, rejecting DDL, classifying DML vs. DDL vs. safe
SELECTs, the confirmation-path validation (`assertConfirmedDml`), and the
LIMIT-injection behavior. `src/db.ts` has integration tests
(`src/db.test.ts`) that run against the real restored `nextgendb` database:
listing tables, running a real read-only query, and confirming a write
attempt is rejected before touching the database. `src/llm/schemaFilter.test.ts`
covers keyword ranking, semantic/vector ranking against a mocked
`/v1/embeddings` response, and the fallback to keyword scoring when that
call fails. `src/databases.test.ts` and `src/llm/models.test.ts` cover the
database/model registries: resolving by id, resolving by `paramsB`,
rejecting unknown or unconfigured selections, and never leaking connection
credentials through the client-facing list endpoints.

Run with `npm test` (42/42 passing).

On top of that, `src/goldset.ts` is a standing 20-question regression set —
each question paired with a hand-verified SQL query and expected result
against the live database. `npm run test:goldset` checks the ground truth
alone (fast, no model calls); `RUN_GOLDSET_LLM=1 npm run test:goldset` runs
the full pipeline for all 20 questions end to end, so a schema change, a
prompt change, or a model swap can be checked against the same 20 questions
before calling it done.
