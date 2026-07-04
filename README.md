# nl2sql-server

Converts an English prompt into SQL and runs it against a PostgreSQL
database, so a user can ask a question without knowing SQL. The default
model runs locally via [Ollama](https://ollama.com) — no cloud API, no
account. It can also be pointed at a bigger model on dedicated hardware
(currently Gemma 3 27B on an H200); either way, the only network calls this
project makes are to the model backend you configure.

## How it works

- `src/db.ts` — connects to Postgres, introspects `information_schema` for
  real tables/columns (`listTables()`), and executes read-only queries
  inside a transaction that's rolled back afterward
  (`executeReadOnlyQuery()`).
- `POST /ask { "prompt": "...", "modelId": "..." }` (`src/routes/ask.ts`):
  1. Introspects the real schema via `db.listTables()`.
  2. **Schema relevance filtering** (`src/llm/schemaFilter.ts`) narrows the
     173-table schema down to the ~20 tables that actually matter for the
     question — see "Why table filtering?" below.
  3. `generateSql()` (`src/llm/generateSql.ts`) sends the filtered schema +
     prompt to whichever model backend was picked and asks for
     `{"sql": "...", "explanation": "..."}` as strict JSON.
  4. `classifySql()` (`src/sqlGuard.ts`) decides what happens next: a plain
     SELECT/WITH runs immediately; an INSERT/UPDATE/DELETE comes back with
     `requiresConfirmation: true` instead of running, and needs an admin
     password at `POST /ask/confirm` before it's actually committed; DDL
     and multi-statement SQL are rejected outright, no password can change
     that.
  5. If a SELECT fails to execute (e.g. an invented table name), the real
     database error is fed back to the model for one self-correction retry.
  6. Errors come back as `{ error, technicalError }` — a short message plus
     the full plaintext detail, so failures are debuggable instead of
     opaque.

## Setup

```
cp .env.example .env   # fill in PG_*, GEMMA_BASE_URL, ADMIN_PASSWORD
npm install
```

Requires [Ollama](https://ollama.com) installed and running locally for the
default model:

```
winget install Ollama.Ollama    # or download from ollama.com
ollama pull qwen2.5-coder:7b    # ~4.7GB, one-time download
```

To use the Gemma 3 27B backend instead, set `GEMMA_BASE_URL` in `.env` to
the real host:port of the OpenAI-compatible server hosting it and pick it
from the model dropdown in the UI (or pass `"modelId": "gemma-3-27b"` to
`/ask`).

Then:

```
npm run dev             # or: npm run build && npm start
```

## Try it

Open `http://localhost:3000/` for a web form (model picker, question in,
results table out — or a password prompt if the generated SQL modifies
data), or call the API directly:

```
curl -X POST http://localhost:3000/ask \
  -H "Content-Type: application/json" \
  -d '{"prompt": "List the 10 most recently added employees"}'
```

Expect roughly 40 seconds per question on the local CPU-only Ollama setup;
the H200-hosted Gemma backend is considerably faster.

## Why table filtering?

Ollama defaults to a small context window regardless of the model's real
capacity, and this database's schema (173 tables, ~2,200 columns) is far
too large to fit alongside it. Rather than force a bigger context window
(which costs RAM this machine doesn't have to spare), `schemaFilter.ts`
keeps only the ~20 tables whose name/columns overlap with words in the
question (`OLLAMA_MAX_TABLES` in `.env`) — a crude but effective stand-in
for the schema-linking a larger model would do implicitly. It's its own
module specifically because it applies the same way regardless of which
model backend answers the prompt.

## Tests

```
npm test              # 24 unit + integration tests, always run
npm run test:goldset  # 20-question gold set, ground truth only (fast)
RUN_GOLDSET_LLM=1 npm run test:goldset   # full pipeline through a live model (slow)
```

`npm test` covers `sqlGuard.ts` (unit) and `src/db.ts` (integration,
against the real restored `nextgendb` database, all read-only). The gold
set in `src/goldset.ts` is a separate, slower regression check meant to be
run by hand after a change that could affect SQL generation — a prompt
tweak, a schema change, a model swap — not on every save. See `PROJECT.md`
for the full writeup.

## Security notes

This is a prototype. Before pointing it at real production data:
- Use a dedicated Postgres role with `SELECT`-only grants where possible,
  or one scoped to exactly the writes you intend to allow through
  `/ask/confirm` — the app-level guard is defense in depth, not a
  replacement for database-level permissions.
- Set a real `ADMIN_PASSWORD` (it's blank by default, which disables the
  confirm endpoint entirely) and treat it like any other production
  secret — it's checked with a plain string comparison, not hashed or
  rate-limited, so it's only as strong as the demo it's protecting.
- Add auth on the `/ask` endpoint itself (today only the confirm step is
  gated).
- Consider a per-user/per-role allow-list of schemas/tables the model is
  even told about, so sensitive tables are never in scope.
