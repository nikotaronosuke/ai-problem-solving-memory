# db

Database assets for the Problem-Solving Memory service.

PostgreSQL is the source of truth for persisted Memory. Supabase is the
first-choice MVP environment, but domain logic must stay PostgreSQL-centric
rather than coupling to Supabase-specific features.

## Current state

Empty on purpose. Nothing here is implemented yet.

Schema and migrations arrive with P1-03 (connection and migration tooling) and
P1-06 onward (Project, Environment, Problem, Event, Verification).

## Rules

- Connection values are read from the environment. Never commit real
  credentials, connection strings or dumps containing Memory content.
- Migrations must be re-appliable to an empty database from scratch.
