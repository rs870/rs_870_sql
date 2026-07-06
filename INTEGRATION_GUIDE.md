# Connecting IRASS (or any frontend) to the NL2SQL API

This is the doc for whoever wires a frontend up to this service. It
assumes no prior familiarity with the codebase, just HTTP and JSON.

## What this service is

A server that takes an English question, turns it into SQL, runs it
against a real database, and returns the result. It talks JSON over HTTP.
There is no SDK to install and no special client library. Any language or
framework that can make an HTTP request and parse JSON can use it.

Base URL during development: `http://localhost:3000` (or whatever
host/port it's actually deployed on, get the real value from whoever's
running the server, it's not fixed in code).

## The short version

```
1. GET /databases   -> find out which databases you can query
2. GET /models      -> find out which LLM backends/sizes are available
3. POST /ask        -> send the question + your chosen database/model
4. Read the response -- either results, or "this needs a password to run"
```

That's the whole integration for a read-only question. Steps 1 and 2 only
need to happen once (e.g. at app startup, to populate a dropdown). They
don't need to be repeated per question unless you want to detect
configuration changes live.

## Step 1: discover available databases

```
GET /databases
```

Response:

```json
{
  "databases": [
    { "id": "nextgendb", "label": "NextGen HRMS (nextgendb)", "configured": true },
    { "id": "db2-placeholder", "label": "Second database (not yet configured)", "configured": false }
  ],
  "defaultDatabase": "nextgendb"
}
```

`configured: false` means that database id exists in the server's registry
but doesn't have real connection details behind it yet. Don't let a user
pick it, or expect an error back if they do. No host, port, or credential
information is ever returned here, so this endpoint is safe to call from
a public frontend.

## Step 2: discover available models

```
GET /models
```

Response:

```json
{
  "models": [
    {
      "id": "qwen2.5-coder-7b",
      "label": "Qwen2.5 Coder 7B (Ollama, local, offline)",
      "shortLabel": "Qwen2.5 Coder 7B",
      "description": "Runs on this machine via Ollama. No network, no data leaves the building.",
      "badge": "local",
      "paramsB": 7
    },
    {
      "id": "gemma-3-27b",
      "label": "Gemma 3 27B (H200)",
      "shortLabel": "Gemma 3 27B",
      "description": "Hosted on a dedicated H200 GPU. Larger model, faster answers.",
      "badge": "remote",
      "paramsB": 27
    }
  ]
}
```

You can select a model two ways in step 3: by `modelId` (exact match
against the `id` field above), or by `paramsB` (the parameter count in
billions, `7` or `27` in the example above). `modelId` wins if you send
both. Picking by `paramsB` is useful if your UI just wants to offer
"small/fast" versus "large/accurate" without hardcoding model names that
might change later.

## Step 3: ask the question

```
POST /ask
Content-Type: application/json
```

Request body:

```json
{
  "prompt": "How many active employees are there?",
  "database": "nextgendb",
  "modelId": "gemma-3-27b"
}
```

Only `prompt` is required. Leave out `database` and it uses the server's
configured default. Leave out both `modelId` and `paramsB` and it uses the
server's default model.

**Successful, read-only answer:**

```json
{
  "prompt": "How many active employees are there?",
  "database": "nextgendb",
  "modelId": "gemma-3-27b",
  "sql": "SELECT COUNT(*) FROM pers.employee_master WHERE is_active = true;",
  "explanation": "This query counts active employees.",
  "columns": ["count"],
  "rows": [{ "count": "965" }],
  "rowCount": 1
}
```

`database` and `modelId` in the response tell you exactly what ran. This
matters most when you asked by `paramsB` instead of `modelId`, since it's
the only place you find out which actual model answered.

**The question implies a write (INSERT/UPDATE/DELETE):**

```json
{
  "prompt": "Mark employee 4021 as inactive",
  "database": "nextgendb",
  "modelId": "gemma-3-27b",
  "sql": "UPDATE pers.employee_master SET is_active = false WHERE user_id = 4021;",
  "explanation": "Sets the employee's active flag to false.",
  "requiresConfirmation": true,
  "operation": "UPDATE"
}
```

Nothing has been written to the database at this point, and nothing will
be unless you follow up with step 4. If your UI doesn't support the write
flow at all, treat `requiresConfirmation: true` as "not executed, ask the
user to rephrase as a question instead," and don't call `/ask/confirm`.

**Something went wrong:**

```json
{
  "error": "Unknown database 'no-such-db'. Available: nextgendb, db2-placeholder",
  "technicalError": "Error: Unknown database 'no-such-db'. Available: nextgendb, db2-placeholder"
}
```

`error` is short and safe to show a user directly. `technicalError` is the
full detail (exception type, and for database errors, the underlying
Postgres error code/detail/hint), useful in a developer console or a
support ticket, not something to put in front of an end user. This shape
is consistent across every failure mode: bad input, unreachable database,
unreachable model backend, a query that fails to execute.

## Step 4: confirming a write (optional)

Only relevant if your application supports the write path at all. Skip
this section entirely if it doesn't.

```
POST /ask/confirm
Content-Type: application/json

{
  "sql": "UPDATE pers.employee_master SET is_active = false WHERE user_id = 4021;",
  "database": "nextgendb",
  "adminPassword": "<the real admin password>"
}
```

Send back the *exact* `sql` string from the `/ask` response. Don't let a
user edit it and don't regenerate it. The server re-validates it
server-side regardless (it still refuses DDL and multi-statement SQL even
with a correct password), but the contract is that this is the same
statement a human or downstream system already saw and approved.

Response on success:

```json
{ "sql": "...", "columns": [], "rows": [], "rowCount": 1 }
```

A wrong password comes back as `401`. A missing or blank server-side
`ADMIN_PASSWORD` config comes back as `503` (the write path is entirely
disabled in that case, on purpose).

## Timing and timeouts

The local model backend answers in roughly 15 to 80 seconds on CPU-only
hardware, depending on the question. The GPU-backed model is considerably
faster. Set your frontend's request timeout accordingly: a 10-second
timeout will fail against the local backend even when everything is
working correctly. The server's own database query timeout is 10 seconds
per statement, so a hang on the database side won't cascade into an
indefinitely stuck request.

## CORS

If your frontend runs in a browser on a different origin than this
server, cross-origin requests are already enabled. The allowed origin is
configured server-side via an environment variable. Ask whoever deploys
the server to set it to your app's real origin once that's known, rather
than leaving it open to any origin.

## Authentication

There currently isn't any on `/ask` itself, only the confirmation step
for writes is password-gated. If this is going to sit anywhere other than
a closed internal network, that's a gap to close before go-live, not
something to build around on the frontend.

## A minimal example

```js
async function askQuestion(prompt, database, modelId) {
  const res = await fetch("http://localhost:3000/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, database, modelId }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error);
  }
  if (data.requiresConfirmation) {
    // show data.sql and data.explanation, ask for a password, then
    // POST /ask/confirm with { sql: data.sql, database: data.database, adminPassword }
    return data;
  }
  return data; // data.columns / data.rows / data.rowCount
}
```

## Questions this doc doesn't answer

Anything about how the server is deployed, scaled, or monitored is
outside the scope of this integration guide. That's an operational
concern for whoever runs the service, not something a frontend
integration needs to know about. If something in an actual response
doesn't match what's documented here, that's a bug in one of the two.
Flag it rather than working around it.
