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

No domain schema exists yet. The baseline migration establishes the migration
pipeline only. Project, Environment, Problem, Event and Verification are
designed from P1-04 onward.

## Rules

- Connection values are read from the environment. Never commit real
  credentials, connection strings or dumps containing Memory content.
- Migrations must be re-appliable to an empty database from scratch. Verify
  with `npm run db:reset`.
