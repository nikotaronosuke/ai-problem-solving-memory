# db

Database notes for the Problem-Solving Memory service.

PostgreSQL is the source of truth for persisted Memory. Supabase is the
first-choice MVP environment, but domain logic must stay PostgreSQL-centric
rather than coupling to Supabase-specific features.

## Where things live

Migrations are **not** here. The Supabase CLI owns them:

| Path                   | Contents                                    |
| ---------------------- | ------------------------------------------- |
| `supabase/migrations/` | Schema migrations, applied in filename order |
| `supabase/config.toml` | Local stack configuration                    |
| `src/db/`              | Application-side connection and health check |

This directory holds database documentation that is not a migration — schema
notes and conventions as they are decided.

See `docs/development.md` for how to run the local database and create
migrations.

## Current state

The domain schema is in place. The tables are `owners`, `projects`,
`environments`, `problems`, `events`, `verifications`, `relations`,
`usage_logs`, `change_logs`, `clients`, `client_credentials` and
`retrieval_artifacts`. Memory control is not a table of its own — read, write,
suppression and invalidation are columns on `problems`.

Shared value sets are PostgreSQL `DOMAIN`s over `text` with CHECK constraints,
mirroring `src/domain/enums.ts` so both sides move together. Every foreign key
is `ON DELETE RESTRICT`, so a parent with children cannot be removed
implicitly.

`supabase/migrations/` is the authority on the schema as it stands;
`docs/development.md` covers running the local database and inspecting it.

## Rules

- Connection values are read from the environment. Never commit real
  credentials, connection strings or dumps containing Memory content.
- Migrations must be re-appliable to an empty database from scratch. Verify
  with `npm run db:reset`.
