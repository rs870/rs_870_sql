# NL2SQL Server — Project Report

## The problem

Getting an answer out of a database usually means knowing SQL, or
bothering someone who does. In an HR system with 173 tables and roughly
2,200 columns, even someone who knows SQL well would have to go hunting
for the right table before they could write a query. Most people asking
"how many employees joined this year" just want the number, not a lesson
in `information_schema`.

This project takes an English question, turns it into a real SQL query
against the actual database, runs it, and hands back the result. No SQL
knowledge required on the asking side.

## What it does, end to end

A user (or another application) sends a question like "how many active
employees are there" to the server. The server:

1. Looks up the real schema of the selected database directly from
   Postgres, not a cached copy, the live `information_schema`.
2. Narrows that schema down to the tables actually relevant to the
   question (more on why this step exists below).
3. Sends the question plus the narrowed schema to a language model and
   asks for a SQL query back, as strict JSON.
4. Checks what kind of query came back. A plain `SELECT` runs immediately,
   read-only, inside a transaction that gets rolled back regardless of
   what happened. An `INSERT`/`UPDATE`/`DELETE` does not run; it comes
   back to the caller marked as needing confirmation, along with an admin
   password prompt. Anything that looks like DDL (`DROP`, `ALTER`,
   `TRUNCATE`, and so on) or has more than one statement in it is rejected
   outright, and nothing short of changing the code will let it through.
5. If the query fails against the real database, usually because the
   model guessed a column or table name that doesn't exist, the actual
   Postgres error gets fed back to the model for one retry, with the exact
   text of what went wrong.
6. Results (or a clear error, split into a short message and the full
   technical detail) go back to the caller as JSON.

## Why schema filtering was the actual hard problem

The obvious first approach, dump the whole schema into the prompt, falls
apart fast. Ollama defaults to a 2048-token context window no matter what
the underlying model can actually handle, and this machine doesn't have
the RAM to push that window much wider without starving the model's own
memory. 173 tables and 2,200 columns don't come close to fitting.

Truncating the schema blindly (just cutting it off at some length) was
tried first and it broke immediately: the model invented a table name
because the real one had been cut off the end of the list. The fix was to
score every table against the question, using keyword overlap between the
question's words and each table's name and column names, and only send
the model the top twenty or so matches. It's not elegant, but it's the
single change that took the pipeline from "works on the demo question" to
"works on questions I haven't tried yet." That's why it's broken out into
its own module (`src/llm/schemaFilter.ts`) instead of living inside
whichever model provider happens to call it.

Once a second, larger model became available on dedicated GPU hardware, a
second filtering strategy got added alongside the keyword one. Instead of
matching on shared words, each table gets turned into a short embedding
vector (via the model server's `/v1/embeddings` endpoint) and ranked by
cosine similarity against the question's own embedding. That catches
matches the keyword approach misses entirely: a question about "staff"
will find a table called `employee_master` even though the two share no
words. If the embeddings call fails for any reason, the endpoint is down,
or the model doesn't support embeddings, the pipeline falls straight back
to keyword scoring instead of failing the request. Schema filtering
degrades gracefully. It never blocks an answer from coming back.

## Two model backends, picked at request time

The default path runs entirely offline: Qwen2.5-Coder 7B through Ollama,
on this machine, no API key, no account, nothing leaving the building.
It's slow on CPU-only hardware, anywhere from about 15 seconds to a
minute and a half depending on the question, but it works with zero
external dependencies.

The second backend points at Gemma 3 27B running on a dedicated H200 GPU,
reachable through an OpenAI-compatible HTTP API. Bigger model, real GPU,
noticeably faster, and it tends to pick the right table even before
schema filtering narrows things down for it. Both backends go through the
exact same schema-filtering and JSON-parsing code (only the HTTP call to
the model itself differs), so adding a third backend later is a matter of
one new registry entry and, if needed, one small provider file.

A caller doesn't have to know model names either. Passing `paramsB: 27`
resolves to whichever registered model has 27 billion parameters, the
same way passing `paramsB: 7` resolves to the local Qwen model. Useful
for a caller that wants "give me the bigger model" without knowing what
it's called this month.

## Multiple databases, same pattern

The database connection followed the same shape once it became clear one
Postgres instance wasn't going to be the only one. Instead of a single
hardcoded connection, `src/databases.ts` holds a small registry of
databases by id, and the server keeps one connection pool per database,
created the first time it's needed and reused after that. A caller
specifies which database to use in the same request that asks the
question. The server looks up the config, gets or creates the right pool,
and runs against that one. A second database slot exists in the registry
right now without real connection details behind it. Selecting it returns
a plain "not configured yet" error instead of a confusing connection
failure, and it becomes real the moment its environment variables are
filled in.

## Safety, not just correctness

A model that can write SQL can, in principle, write a `DROP TABLE`. Three
layers stand between "the model proposed this" and "this ran against real
data":

- `classifySql()` decides the category before anything executes. DDL is
  rejected unconditionally; there is no password that unlocks it.
- A write (`INSERT`/`UPDATE`/`DELETE`) doesn't run either, but it's not
  rejected. It comes back to the caller with the generated SQL and a flag
  saying it needs confirmation. The caller re-submits that exact SQL along
  with an admin password to a separate endpoint before it actually
  commits, and the server re-validates the SQL server-side rather than
  trusting that the client didn't tamper with it in between.
- Every read runs inside `BEGIN TRANSACTION READ ONLY ... ROLLBACK`, so
  even a bug somewhere upstream can't leave a write on the table.

None of this replaces real database-level permissions. The Postgres role
in use during development has more privilege than the app strictly needs,
and that's called out explicitly as a known gap rather than something
papered over.

## Turning it into something another application can call

Everything above was originally built for a browser page: type a
question, see a results table. Making it usable by another application
(an internal system called IRASS, in this case) meant treating `/ask` as
a real contract instead of an implementation detail of the web UI:

- The request and response are both plain JSON, no HTML anywhere in the
  exchange except the one route that serves the human-facing page.
- Configuration a caller needs (which databases exist, which models exist
  and how big they are) is discoverable over HTTP (`GET /databases`,
  `GET /models`) instead of hardcoded on either side. Selecting one is a
  field in the request body, and the response echoes back exactly what
  ran, including the *resolved* model id even when the caller only
  specified a parameter count.
- CORS is enabled so a browser-based frontend hosted on a different
  origin than this server can call it directly, with the allowed origin
  controlled by one environment variable rather than hardcoded.

The web UI and the external API are the same code path on purpose. There
was a real decision point here: build a separate endpoint for external
callers, or extend the existing one. Extending it won. Two contracts for
the same operation is two places to keep in sync, and two places for them
to quietly drift apart.

## What's actually been verified, not just written

- All 20 questions in the gold-set regression suite return the exact,
  hand-verified answer when run directly against the database (employee
  counts, gender splits, blood group distribution, training records, and
  so on: real numbers checked against the restored `nextgendb` backup,
  not made up for the demo).
- A full round trip, English question in, generated SQL, real rows out,
  has been run live against both the local Qwen model and confirmed
  against the actual Postgres instance, not just in a test file.
- The self-correction retry has actually caught a bad table name mid-run
  and recovered on the next attempt, not just in theory.
- A generated `DELETE` was confirmed to stop at the confirmation step
  instead of running.
- 42 automated tests pass: unit tests for the SQL safety classifier,
  integration tests against the live database, and tests for the schema
  filter's fallback behavior using a mocked embeddings response.

## What's deliberately out of scope right now

This is a prototype, and a few gaps are intentional rather than
overlooked:

- No authentication on `/ask` itself, only the confirmation step for
  writes is password-gated. Fine for a demo behind a closed network, not
  fine for anything public.
- The Postgres role used has more access than the application logic
  actually exercises. The app-level guard is the real enforcement today;
  database-level permissions should be tightened before this touches real
  production data.
- Only one database is actually wired up with real credentials. The
  second slot in the registry exists specifically so that adding a real
  second database later doesn't require touching application code, only
  configuration.

## Where this could go next

The two obvious directions are also the two things flagged above: locking
down auth and database-level permissions for anything beyond a demo
environment, and filling in a real second (or third) database now that
the registry supports it without a rewrite. Beyond that, the semantic
schema-filtering step could be extended to columns as well as tables once
there's a concrete case where table-level filtering alone picks the right
table but the wrong column.
