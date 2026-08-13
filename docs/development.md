# Development

Local setup and the fixed commands for this repository.

## Requirements

- Node.js >= 22.12.0 (Node 24 is also supported)
- npm (the package manager for this repository; `package-lock.json` is committed)
- Docker, running. The local Supabase stack runs in containers, so starting it,
  resetting the database and the integration tests all need a live Docker daemon.

The Supabase CLI is a devDependency, not a global install. Every command below
resolves it from `node_modules`.

## Setup

```bash
npm install
cp .env.example .env
```

`.env` is git-ignored. `.env.example` contains placeholders only and must never
hold real values.

## Local database

```bash
npm run supabase:start   # start the local stack (first run pulls images)
npm run db:status        # show local URLs, including the DB URL
npm run supabase:stop    # stop the stack
```

Copy the `DB URL` printed by `npm run db:status` into `DATABASE_URL` in `.env`.
That URL contains a password: keep it in `.env`, and never in a committed file,
a doc or a commit message.

Only the services this project uses are enabled in `supabase/config.toml`.
Auth, Storage, Realtime, Edge Runtime, the local SMTP catcher and analytics are
turned off — the Memory service talks to PostgreSQL directly, and owner
identity is the Memory Server's own responsibility.

> Docker publishes these ports on all interfaces, not just loopback. Stop the
> stack with `npm run supabase:stop` when you are not using it.

## Migrations

Supabase migrations under `supabase/migrations/` are the source of truth for
schema. They are plain SQL, applied in filename order.

```bash
npm run db:migration:new <name>   # create a timestamped migration file
npm run db:migrate                # apply pending migrations
npm run db:reset                  # rebuild the local DB from scratch
```

`db:migrate` applies migrations that have not run yet. `db:reset` drops the
local database and replays every migration in order, which is how you verify a
migration works on a clean database. Run `db:reset` before relying on any
schema change.

The migrations establish the pipeline, the shared value sets (PostgreSQL
DOMAINs over `text` with CHECK constraints, mirroring `src/domain/enums.ts`),
the nine tables — `owners`, `projects`, `environments`, `problems`, `events`,
`verifications`, `relations`, `usage_logs`, `change_logs` — and the Phase 1
integrity and index set.

Every foreign key deletes with `RESTRICT`, so a parent with children cannot be
removed. That prevents implicit deletion, not deletion: a deliberate removal
works from the leaves up.

Changing an allowed value means changing both sides: the tuple in
`src/domain/enums.ts` and a new migration. `tests/db/enums.integration.test.ts`
fails if only one of them changes.

## Local owner

All Memory data is owned. `MEMORY_OWNER_ID` names the owner local development
acts as — a UUID the Memory Server issues, never an AI vendor, GitHub or other
provider account id.

Generate one, put it in `.env`, and create the matching row:

```bash
node -e "console.log(crypto.randomUUID())"   # paste into MEMORY_OWNER_ID in .env
npm run owner:bootstrap
```

`owner:bootstrap` is safe to run repeatedly: it creates the owner if absent and
otherwise leaves it untouched. It creates no credential. Run it again after
`npm run db:reset`, which drops the owner along with everything else.

Owner-scoped work resolves a context first, and refuses to start when the owner
is unset, malformed, or absent from the database.

## Running the server

```bash
npm run dev     # from TypeScript, with watch
npm start       # from dist/, after npm run build
```

It binds to `HOST` and `PORT` from `.env`, defaulting to `127.0.0.1:3000` —
loopback, so reaching the network is a deliberate choice.

```bash
curl http://127.0.0.1:3000/health   # {"status":"ok"}
curl http://127.0.0.1:3000/v1/me    # {"owner_id":"..."}
```

The Memory JSON API lives under `/v1`; `/health` sits outside it, because
whether the process is serving is not part of the API contract. Everything
under `/v1` needs an owner, so `npm run owner:bootstrap` must have run.

Three descriptions of this API would be two too many, so they have different
jobs. The **machine-readable contract** is `GET /openapi.json` — OpenAPI 3.1,
generated at startup from the schemas the routes declare, which is what a
client generator should read. The **semantics** are in
[`api-contract.md`](./api-contract.md): what a 404 means, how
`expected_version` and `client_event_id` behave, what counts as evidence. What
follows here is the working narrative for someone changing the code, and it
does not restate field lists that the OpenAPI document already carries.

| Method | Path                                          |
| ------ | --------------------------------------------- |
| GET    | `/v1/me`                                      |
| POST   | `/v1/projects`                                |
| GET    | `/v1/projects`                                |
| GET    | `/v1/projects/:project_id`                    |
| PATCH  | `/v1/projects/:project_id`                    |
| POST   | `/v1/projects/:project_id/environments`       |
| GET    | `/v1/projects/:project_id/environments`       |
| GET    | `/v1/environments/:environment_id`            |
| POST   | `/v1/projects/:project_id/problems`           |
| GET    | `/v1/projects/:project_id/problems`           |
| GET    | `/v1/problems/:problem_id`                    |
| PATCH  | `/v1/problems/:problem_id`                    |
| POST   | `/v1/problems/:problem_id/events`             |
| GET    | `/v1/problems/:problem_id/events`             |
| POST   | `/v1/problems/:problem_id/verifications`      |
| GET    | `/v1/problems/:problem_id/verifications`      |
| PATCH  | `/v1/problems/:problem_id/memory-control`     |
| POST   | `/v1/problems/:problem_id/status-transitions` |
| POST   | `/v1/problems/:problem_id/relations`          |
| GET    | `/v1/problems/:problem_id/relations`          |
| POST   | `/v1/problems/:problem_id/usage-logs`         |
| GET    | `/v1/problems/:problem_id/usage-logs`         |
| GET    | `/v1/problems/:problem_id/change-logs`        |
| POST   | `/v1/problems/:problem_id/close`              |

Outside `/v1`, alongside `/health`: `GET /openapi.json`, which needs no owner.
It is generated rather than written, so a route schema change shows up in it
in the same commit. It does not list itself.

Environments are created and listed under their project, so the project id
has one source and cannot disagree with itself. An Environment is a point in
time: there is no update or delete for one, and nothing is deleted in this
phase.

Problems are created under their project too, and name an environment that
must belong to that same project. A new Problem starts `INVESTIGATING` with
no fix kind, low confidence and version 1 — the caller does not get to
declare any of that.

A patch changes only the fields it names. `status`, `fix_kind` and `version`
are not among them: state transitions have their own endpoint, `fix_kind` is
written when a Problem is closed, and `version` is the server's to move.
Sending one is a validation failure rather than a silent no-op. `importance`,
`confidence`, `freshness`, `suppressed` and the two memory flags are
independent — setting any one of them never moves another.

Every write to a Problem carries `expected_version`, the version the caller
last read:

```json
{ "expected_version": 4, "changed_by": "claude-code", "title": "..." }
```

`changed_by` is required on both write paths and says who is making the
change. It is recorded in the change log rather than on the Problem, and it is
descriptive: whatever a caller writes there, the owner comes from the
established request context and the same data is reachable.

If the Problem is still at that version the write happens and the version
becomes 5; if not, nothing is written and the response is `409` with code
`VERSION_CONFLICT`. Re-read the Problem and decide again. Two people or
assistants working on the same Problem is the normal case, and a silent
overwrite would lose a finding without either of them noticing — which is
worse than an error, because it looks like it worked.

The ordinary patch, the status transition, the memory controls and closing all
share that one version, so any two of them conflict with each other rather
than passing unseen.
Appends do not: an Event or Verification can be recorded whatever version the
Problem is at, and recording one does not move it. Retry safety for an append
is `client_event_id`, which answers a different question.

Events record what happened while a problem was being solved: a hypothesis,
an attempt, a dead end, a discovery, a fix, a correction from the user. They
are append-only — there is no update, delete or single-event read, and a
later correction is a `USER_CORRECTION` event.

Every append carries a `client_event_id`, a UUID the caller mints before its
first attempt and reuses if that attempt has to be retried. A retry returns
the event the first attempt wrote, with the same 201 and the same body, so a
client that never learned whether its request arrived can simply send it
again. The key belongs to the owner rather than to a problem: sending it at a
different problem replays the original rather than recording a second event,
which is how a client finds out it reused a key. If the retry's payload
differs, the first write still wins.

Verifications record that something actually checked whether the state holds
— a test run, a build, a real device, an API or database result, a person
confirming it. They attach to the Problem, never to an Event: a FIX Event
says what was changed, and a Verification says whether it worked. An
assistant saying "it works" is not evidence that it does, which is why the
two are separate records.

`result` is a boolean. True means a check was carried out and confirmed the
state; false means it was carried out and did not. Neither means "not checked
yet" — that is simply the absence of a Verification — so a string, a number
or a null is refused rather than coerced.

Appending is idempotent on `client_event_id` in the same way as Events, with
one thing worth stating plainly: a retry cannot change a recorded `result`. A
retry is the same write arriving again, not a second check. Recording a
different finding means a new Verification with a new key.

Recording a successful Verification does not move the Problem to `VERIFIED`
and does not change its status at all. Concluding a problem is solved is a
separate, deliberate step.

That step is `POST /v1/problems/:problem_id/status-transitions`, with a body
naming only where the Problem should end up:

```json
{ "target_status": "FIX_CANDIDATE", "expected_version": 4, "changed_by": "claude-code" }
```

It is the only way a status changes — the Problem PATCH still refuses
`status`, and no append moves it. The allowed moves are:

| From                | To                                                         |
| ------------------- | ---------------------------------------------------------- |
| `INVESTIGATING`     | `FIX_CANDIDATE`, `PAUSED`, `CLOSED_UNRESOLVED`             |
| `FIX_CANDIDATE`     | `INVESTIGATING`, `VERIFIED`, `PAUSED`, `CLOSED_UNRESOLVED` |
| `PAUSED`            | `INVESTIGATING`, `FIX_CANDIDATE`, `CLOSED_UNRESOLVED`      |
| `VERIFIED`          | —                                                          |
| `CLOSED_UNRESOLVED` | —                                                          |

`PAUSED` is resumable, which is the point of it. `VERIFIED` and
`CLOSED_UNRESOLVED` are ends: reopening one raises questions about whether
the old evidence still holds, and nothing answers those yet.

`VERIFIED` is reachable only from `FIX_CANDIDATE`, and only when the Problem
has at least one Verification of its own whose `result` is true. A FIX event,
a confident summary, a high confidence level and another Problem's evidence
all count for nothing. Anything the rule refuses is a 400, and the Problem is
left exactly as it was — status, `updated_at` and all.

A transition changes the status and nothing else. `fix_kind`, `confidence`,
`freshness`, `importance` and the memory flags stay where they were:
verifying a Problem says the fix holds, not that anyone is more confident in
the record or that the fix addressed the cause. The version moves, as it does
for any successful write.

Ending a Problem usually means more than moving its status, and
`POST /v1/problems/:problem_id/close` is the one request for the whole of it:

```json
{
  "expected_version": 4,
  "changed_by": "claude-code",
  "target_status": "VERIFIED",
  "fix_kind": "ROOT_FIX",
  "final_cause_summary": "The provider's registered redirect never matched.",
  "effective_direction": "Align the registered redirect with the deployed one.",
  "dead_end_summary": "Changing the app route alone did nothing.",
  "unresolved_points": "Why preview differs from production is still open."
}
```

Only the three conclusions are accepted: `VERIFIED`, `PAUSED` and
`CLOSED_UNRESOLVED`. `INVESTIGATING` and `FIX_CANDIDATE` are working states
and stay with the transition route, which is unchanged — two surfaces doing
the same move differently is worse than one of them saying no.

Underneath it is the same transition matrix and the same evidence gate.
`VERIFIED` still comes only from `FIX_CANDIDATE`, and still only with a
successful Verification of the Problem's own; a well-argued
`final_cause_summary` is not evidence. A terminal Problem cannot be closed
again, so this is not a way to revise a conclusion. Anything refused is a 400,
and nothing at all is written.

`fix_kind` is writable here and nowhere else in this phase — whether a fix
addressed the cause or worked around it is a conclusion rather than an edit.
Omitting it leaves whatever is there; sending `null` clears it. It is a
separate axis from status in both directions: a Problem can be verified with
no fix kind stated, and a `WORKAROUND` can be recorded on one that was only
set aside.

The four summaries are optional and each becomes an ordinary Event:
`final_cause_summary` a `DISCOVERY`, `effective_direction` a `FIX`,
`dead_end_summary` a `DEAD_END`, `unresolved_points` a `HYPOTHESIS`. There is
no Review resource and no new event type: a review is a set of statements about
the investigation, and putting them anywhere else would leave the same
information in two places. An open question is recorded as a `HYPOTHESIS`
rather than a `DISCOVERY`, because filing an unknown as a fact is the mistake
this record exists to avoid. `changed_by` becomes each Event's `source_ai`.
Closing with no summaries is fine — the history may already say everything
worth saying.

All of it is one act: the status and fix kind settle, the Events are written
and one change log entry records it, in a single transaction and a single
version step. Written together, they share a `created_at` and so have no
order among themselves — each carries its own type, so a reader never needs
one to tell them apart. A Problem marked verified with the account of why missing is the
worst available outcome, so either all of it commits or none of it does. The
summaries themselves stay out of the change log, which names `status` and, if
the request mentioned it, `fix_kind`.

Because the whole close is protected by `expected_version`, resending one that
already succeeded conflicts rather than recording the review twice. There is
no `client_event_id` here for the same reason.

Nothing else is inferred. Closing does not raise confidence, refresh
freshness, touch the memory controls, or create the Verification it requires.
`PAUSED` stays resumable through the transition route, and the review it left
behind remains as history.

JSON is snake_case and timestamps are ISO 8601. A resource that belongs to
another owner answers exactly as one that does not exist.

Failures share one shape, and a client branches on `error.code`:

```json
{ "error": { "code": "UNAUTHENTICATED", "message": "..." }, "request_id": "..." }
```

## Checking the database connection

```bash
npm run db:check
```

Opens a pool, runs `select 1`, prints the host and round-trip time, then closes
the pool. It reports the host but never the connection string.

## Commands

| Command                    | Purpose                                           |
| -------------------------- | ------------------------------------------------- |
| `npm run dev`              | Run the server from TypeScript, with watch        |
| `npm run build`            | Compile `src/` to `dist/`                         |
| `npm start`                | Run the compiled server                           |
| `npm run typecheck`        | Type-check `src/` and `tests/` without emitting   |
| `npm run lint`             | ESLint (type-aware rules enabled)                 |
| `npm run lint:fix`         | ESLint with autofix                               |
| `npm run format`           | Prettier, writing changes                         |
| `npm run format:check`     | Prettier, verifying only                          |
| `npm test`                 | Vitest, single run                                |
| `npm run test:watch`       | Vitest, watch mode                                |
| `npm run check`            | typecheck + lint + format:check + test            |
| `npm run supabase:start`   | Start the local Supabase stack                    |
| `npm run supabase:stop`    | Stop the local Supabase stack                     |
| `npm run db:status`        | Show local stack URLs                             |
| `npm run db:reset`         | Rebuild the local DB from migrations              |
| `npm run db:migrate`       | Apply pending migrations                          |
| `npm run db:migration:new` | Create a new migration file                       |
| `npm run db:check`         | Verify the service can reach PostgreSQL           |
| `npm run owner:bootstrap`  | Create the local owner named by `MEMORY_OWNER_ID` |

Run `npm run check` before reporting a task complete.

## Layout

| Path                   | Contents                                               |
| ---------------------- | ------------------------------------------------------ |
| `src/`                 | Service implementation                                 |
| `src/domain/`          | Domain types, shared value sets and owner identity     |
| `src/owner/`           | Owner context resolution and local bootstrap           |
| `src/http/`            | HTTP transport — building an app starts nothing        |
| `src/app/`             | Application services transport depends on              |
| `src/db/`              | Database access boundary — importing it opens nothing  |
| `src/repository/`      | Owner-scoped storage seam the service layer works with |
| `tests/`               | Automated tests, mirroring `src/`                      |
| `supabase/migrations/` | Schema migrations, in filename order                   |
| `supabase/config.toml` | Local stack configuration                              |
| `db/`                  | Database notes                                         |
| `docs/`                | Public implementation documentation                    |
| `.ai/`                 | Implementation state for AI sessions — see `CLAUDE.md` |

## Conventions

- ESM only (`"type": "module"`). Relative imports carry the `.js` extension,
  as required by TypeScript's `NodeNext` resolution.
- TypeScript runs in strict mode. Prefer fixing types over `any` or assertions.
- Deterministic, repeatable work belongs in ordinary code. Reserve model
  inference for semantic judgement — summarisation, similarity, comparison.

## Scope reminder

This repository is the Problem-Solving Memory service alone. It is not the
Personal AI Development OS. Tool Gateway, shared credential management, the
shared Approval Engine, Skill Registry, Workflow Engine, Model Router and the
OS-wide audit warehouse stay outside this repository. See `CLAUDE.md`.

Relations link two of your Problems with a stated meaning — `SIMILAR_TO`,
`RELATED_TO`, `CAUSED_BY`, `SUPERSEDES`, `CONTRADICTS` or `DERIVED_FROM` —
and a `reason` explaining why. The source comes from the path, the target from
the body:

```json
{ "to_id": "...", "relation_type": "SIMILAR_TO", "reason": "..." }
```

The two Problems may be in different projects. That is the point: a problem
solved in one project informing an investigation in another is what makes
this memory worth keeping. They may not be in different owners' accounts, and
refusing that reveals nothing — another owner's Problem answers exactly as one
that does not exist. A Problem cannot be linked to itself.

Listing a Problem's relations returns links from both ends, so a Problem that
only ever appeared as a target still sees them. Rows come back as stored
rather than flipped to suit whose list is being read: a link recorded as A
supersedes B says the same thing from B's side. Only one row is stored per
link, including for the three symmetric meanings.

A relation is a link, not an inheritance. It carries no status, confidence,
freshness or evidence across, and it does not touch either Problem — neither
version moves, so no `expected_version` is involved. Relating a Problem to a
verified one does not let it become `VERIFIED`; it still needs a successful
Verification of its own.

Create and list only. There is no single-relation read, update or delete: how
a mistaken link is corrected is not decided yet.

Usage logs record that past memory was actually used while solving a problem:
`SEARCHED` when it came up as a candidate, `REFERENCED` when it was read,
`ADOPTED` when its direction was taken, `EXCLUDED` when it was considered and
set aside, `CHANGED_STRATEGY` when it changed the approach. The problem being
worked on comes from the path; the past problem used as memory comes from the
body, along with who used it and why:

```json
{
  "source_ai": "claude-code",
  "action": "REFERENCED",
  "memory_id": "...",
  "reason": "Same authentication boundary and symptoms.",
  "result": null
}
```

`reason` is required — without it the log is a hit counter, and the question
worth answering later is whether the memory deserved to be used. `result` is
null when the outcome is not known yet, which is the ordinary state for a
memory that was merely found or read.

No order is required between the actions. An adapter reports what it can tell,
and requiring `SEARCHED` before `ADOPTED` would make this a workflow rather
than a record of what happened.

`source_ai` describes who used the memory and is never consulted for
authorisation. Whatever a caller writes there, the owner comes from the
established request context and the same data is reachable.

Logging is explicit. No read writes one: fetching a problem or listing its
events, verifications or relations records nothing. A read that quietly writes
can fail for reasons the caller did not ask about, and it would claim a memory
was _used_ when all that happened was a look.

Memory used across projects is the point, and is allowed. Memory across owners
is not, and refusing it reveals nothing — another owner's problem answers
exactly as one that does not exist. A problem may be recorded as its own
memory, which is what continuing an investigation under a different AI looks
like.

Recording a use changes nothing about either problem: no version, no status,
no confidence, and no relation, event or verification appears. Adopting a
verified memory does not make the current problem verified.

This is Memory-specific history, not a general audit log. Tool calls, deploys,
model invocations and approvals are not recorded here.

Create and list only, like relations: no single-log read, update or delete.

Every successful change to a Problem is recorded, automatically, as part of
the same database transaction as the change itself. There is no endpoint that
writes one: a Problem edited with no record of it, and a record of an edit
that did not happen, are both worse than the write failing outright, so the
two commit or roll back together.

Read a Problem's history with `GET /v1/problems/:problem_id/change-logs`:

```json
{
  "change_logs": [
    {
      "change_log_id": "...",
      "problem_id": "...",
      "changed_by": "claude-code",
      "from_version": 1,
      "to_version": 2,
      "changes": {
        "confidence": { "kind": "exact", "before": "LOW", "after": "HIGH" }
      },
      "created_at": "..."
    }
  ]
}
```

One entry per mutation, not per field: a patch that changes five things is one
thing that happened. The version pair brackets it, so the history reads as a
chain.

What an entry may contain is deliberately uneven. Controlled values — status,
fix kind, importance, confidence, freshness, the memory flags — keep their
before and after exactly, because that is what shows how judgement changed and
because a value from a closed set cannot be a secret. Free text is described
rather than copied:

```json
{
  "title": {
    "kind": "text_redacted",
    "before_present": true,
    "after_present": true,
    "changed": true
  }
}
```

Titles and symptom notes can hold anything someone wrote, including things
that later have to be removed, and a copy in the history would outlive the
removal. What survives is enough to follow the shape of an edit without
carrying its contents.

A refused change records nothing — a stale version, a disallowed transition, a
patch with nothing to change, a problem that is not yours. Only Problem
mutations are tracked: creating a Problem, appending an event or verification,
linking a relation and recording usage all leave the history untouched.

There is no update or delete for an entry, and no way to write one directly.

Memory controls decide how a Problem should be used as memory, rather than
what it says. `PATCH /v1/problems/:problem_id/memory-control` carries the same
`expected_version` and `changed_by` as any other Problem write, plus at least
one control:

```json
{
  "expected_version": 4,
  "changed_by": "claude-code",
  "memory_read_enabled": false,
  "suppressed": true,
  "invalidate": true
}
```

Three independent axes, and they stay independent. `memory_read_enabled` is
whether this Problem should be drawn on when memory is consulted
automatically; `memory_write_enabled` whether an assistant should add to it on
its own; `suppressed` means surface it less, saying nothing about whether it
still holds. `invalidate: true` sets `freshness` to `INVALID` — the record no
longer holds as a basis for judgement — and nothing else. Turning off reads
does not suppress, suppressing does not invalidate, and invalidating disables
nothing: a retrieval layer will want to treat "do not read this" and "this
turned out to be wrong" differently.

`invalidate` accepts only `true`. There is no un-invalidate, because it could
not know what to restore: a Problem that became `INVALID` may have been
`CURRENT` before it, or `STALE_UNKNOWN`, or `SUPERSEDED`. Saying a memory
holds again means saying which of those it is, through the ordinary update —
which is also why this route refuses `freshness` directly.

These controls are not authorisation. Turning everything off leaves every read
of your own Problem working, and leaves the controls reachable, so nothing can
be locked away by accident. They are not enforced yet either: nothing
retrieves memory automatically, and nothing can tell your own write from an
assistant's, so no endpoint starts refusing on the strength of a flag.
Recording the intent is what lets the layer that can tell the difference
honour it later.

Modifying a Problem's content is still `PATCH /v1/problems/:problem_id`, which
also continues to accept these fields and `freshness`. The control route is a
surface for deliberate decisions about use; it took nothing away from the
ordinary update.

A control change is a Problem write like any other: same version column, same
compare-and-swap, same transaction, and one change log entry however many
controls moved at once.
