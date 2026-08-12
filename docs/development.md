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
the six tables — `owners`, `projects`, `environments`, `problems`, `events`,
`verifications` — and the Phase 1 integrity and index set.

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
whether the process is serving is not part of the API contract. `/v1/me`
needs an owner, so `npm run owner:bootstrap` must have run.

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
