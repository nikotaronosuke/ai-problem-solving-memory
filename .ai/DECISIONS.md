# DECISIONS

Updated: 2026-08-11

This file records implementation-facing decisions that are safe to keep in the public repository. Detailed product rationale remains in the private specification repository.

## D-001 — Public implementation / private detailed specification

The public repository `nikotaronosuke/ai-problem-solving-memory` contains implementation code, public documentation and implementation state.

Detailed upstream specification and task breakdown remain in the private repository `nikotaronosuke/ai-problem-solving-memory-spec`.

## D-002 — Source of truth

`docs/spec/final-mvp-spec.md` in the private repository is the highest-priority MVP specification. Phase documents remain design history and rationale.

## D-003 — Implementation phases

Implementation is divided into Phases 1–9. Each Phase has a Definition of Done and is completed/reviewed before dependent later phases begin.

## D-004 — Core MVP milestone

Implementation Phase 7 is the Core MVP validation gate. UI and conversational AI adapters do not substitute for the required cross-project reuse E2E.

## D-005 — Initial technical direction

The MVP is planned around TypeScript / Node.js with PostgreSQL. Supabase is the first-choice MVP PostgreSQL environment while domain logic should avoid unnecessary Supabase-specific coupling.

## D-006 — AI integration boundary

Memory Server/API is the source of truth. AI-specific behavior belongs behind adapters. No single AI vendor or protocol owns the Memory model.

## D-007 — Git operating rule

AI agents must not push unless explicitly requested by the user. Destructive git operations require explicit approval.

## D-008 — Development toolchain (P1-01)

The implementation toolchain is fixed as: npm as package manager with a committed lockfile, TypeScript in strict mode, ESM with `NodeNext` module resolution, ESLint 9 flat config with type-aware rules, Prettier for formatting, and Vitest as the test runner.

Verification commands are `npm run typecheck`, `npm run lint`, `npm run format:check` and `npm test`, aggregated as `npm run check`.

Prettier does not format `README.md`, `CLAUDE.md` or `.ai/`. Those are hand-maintained prose edited by humans and AI sessions, and automated reformatting would create noise without benefit.

`.gitattributes` fixes the working tree to LF so formatting checks behave identically on every platform.

## D-009 — Database access and migrations (P1-03)

Migrations are owned by the Supabase CLI and live in `supabase/migrations/` as plain SQL applied in filename order. `npm run db:reset` rebuilds a local database from them, which is how a migration is verified against a clean database.

The Supabase CLI is a devDependency, not a global install, so the migration tool is pinned per repository.

Application access to PostgreSQL uses `pg` (node-postgres) with a connection pool. Supabase is the local environment providing PostgreSQL; it is not an application dependency. The service does not use PostgREST, Supabase Auth, Storage, Realtime or Edge Functions, and those are disabled in `supabase/config.toml`. This keeps D-005's PostgreSQL-centric boundary real rather than aspirational.

`src/db/` is the database boundary, split so that configuration resolution, pool lifecycle and health probing are separately testable. Importing any module in it opens no connection; a pool exists only when a caller asks for one, and the caller closes it.

## D-010 — Database credential handling (P1-03)

`DATABASE_URL` is read only from the environment, and only where a connection is actually opened. Code that does not touch the database — including most tests — runs without it.

A connection string is treated as a credential. It must not appear in an error message, a log line, a test fixture, `.ai/`, `docs/` or Memory content. Errors report the host, which carries no credential, and the reason.

While `NODE_ENV=test`, connecting to a non-local database host is refused. Test runs cannot reach a real deployment even if the environment is pointed at one.

## D-011 — Local stack exposure (P1-03)

Docker publishes the local Supabase ports on all interfaces rather than loopback only. The repository reduces the exposure it controls by enabling only the services this project uses, leaving three published ports.

The remaining binding behavior is a machine-wide Docker daemon setting, so it is deliberately not changed by this repository. This is accepted rather than treated as a blocker: the local stack holds no real Memory data, and the operating rule is to stop it when not in use. Revisit if the stack ever needs to run on an untrusted network.

## D-012 — Closed value sets use text-backed DOMAINs, not native enums (P1-04)

A value set with a fixed list of allowed values is represented in PostgreSQL as a DOMAIN over `text` with a named CHECK constraint, not as a native `ENUM` type.

Reasons: a DOMAIN can be defined before any table exists, so database-level constraints are in place ahead of the schema; changing the allowed set is an ordinary migration rather than enum type surgery; and columns reuse the DOMAIN by name from P1-06 onward.

Nullability is not part of a DOMAIN. Whether a value may be absent belongs to the column that uses it.

On the application side each set is declared once, as a readonly tuple in `src/domain/enums.ts`, with its type derived from that tuple. No value is written twice in TypeScript. `src/db/enum-domains.ts` is the single place pairing a set with its DOMAIN, and lives in the database boundary so the domain layer holds no persistence names.

The two sides are kept in step by behavior against a real database, not by parsing migration text: every application value is cast through its DOMAIN, and the constraint is read back from PostgreSQL's catalog and compared with the application set. A change to one side without the other fails the test suite.

## D-013 — Owner identity is issued and owned by the Memory Server (P1-05)

`owner_id` is a UUID the Memory Server manages, stored as PostgreSQL `uuid`. It is never an AI vendor account id, a GitHub user id, or a value derived from any external provider identity, and the Memory model does not map to provider accounts.

This follows directly from the product invariant that Memory is user-owned and not tied to one AI vendor. Ownership has to survive changing the AI, the account behind it, or the protocol in front of it. Owner identity is therefore not delegated to Supabase Auth, which stays disabled in this repository.

The column carries no database-side default. The application always supplies the id, so ownership is an explicit decision rather than something the database invents on insert.

`OwnerId` is a branded type in TypeScript: an arbitrary string cannot be used as an owner, and a value becomes an `OwnerId` only by passing UUID validation. Values are normalised to lowercase, matching what PostgreSQL returns, so the same owner cannot compare unequal depending on which side it came from.

## D-014 — Owner context is required before owner-scoped work (P1-05)

Owner-scoped operations take an `OwnerContext` rather than a bare id. A context is produced only by resolution, which fails closed on three distinguishable conditions: the owner is not configured, the configured value is not a usable id, or it names an owner with no row. A well-formed UUID is not sufficient — the owner must exist.

Resolution runs when owner-aware work begins, not at import time, so code that never touches owned data keeps working without an owner configured.

The read path takes the context and returns only that owner. No application API accepts an arbitrary owner id and returns its record, so crossing the ownership boundary is not something a caller can express. The bootstrap path that creates a local owner is kept separate and only ever inserts.

A rejected owner value is never echoed in an error. A misconfigured variable can hold something that was never meant to be printed, so only the reason is reported. An id that has already been validated as a UUID is safe to name, and is, because that is what makes an unknown owner debuggable.

## D-015 — Authentication is staged across phases (P1-05)

P1-05 covers owner identity, local owner context and the owner boundary, and nothing more. In local development the owner comes from `MEMORY_OWNER_ID`.

Deliberately deferred: HTTP request auth context is P2-01. Client credentials, their lifecycle and revocation, and the separation of owner identity from client identity are P3-04.

No token table, bearer token, OAuth flow, JWT, password, session, credential hash or provider account mapping exists in this phase, and none should be added ahead of the phase that owns it.

## D-016 — Project ids are application-generated UUIDs (P1-06)

`project_id` is a UUID issued by the application, stored as PostgreSQL `uuid` with no database-side default, and validated through a branded `ProjectId` type. It is not derived from a repository URL, a hosting provider id or anything outside this service.

This follows the same reasoning as owner identity: an id that comes from a provider stops being stable when the provider does. Keeping generation in the application also means an id exists before the insert, which later phases need for idempotent writes.

The shared UUID rule now lives in `src/domain/uuid.ts` so the layout check is written once rather than restated per entity.

This decision is recorded for Project. It is a strong precedent for the entities that follow, not a blanket ruling for all of them — P1-07 onward confirm the fit at each entity rather than inheriting it silently.

## D-017 — Owner foreign keys use ON DELETE RESTRICT (P1-06)

`projects.owner_id` references `owners.owner_id` with `on delete restrict`. Deleting an owner that still has data fails.

Cascade would let a single delete silently remove Memory, which contradicts the product invariant that Memory is the user's and that removal is deliberate. Refusing the delete makes the consequence visible and forces an explicit path.

This sets the default for owner-scoped tables. The full delete lifecycle, including how an owner is ever removed and how cascade and restrict apply across the whole schema, is settled in P1-11.

## D-018 — repo and platform are nullable free-form text (P1-06)

`projects.repo` and `projects.platform` are nullable text with no enum, no unique constraint and no format requirement.

A project may legitimately have no repository, and its platform may be undetermined. Constraining either now would encode a provider's shape — a GitHub URL, a fixed platform list — into the schema before the retrieval work has shown what the fields need to carry. Free-form text with null for "unknown" keeps that open.

The only normalisation applied is trimming, with blank collapsing to null, so "unknown" has one representation rather than several that compare unequal.

## D-019 — Environment is an immutable point-in-time snapshot (P1-07)

`environment_id` is an application-issued UUID with no database default, consistent with owner and project.

An Environment records the conditions in place when a problem occurred. It has no `updated_at` and no update path: when conditions change, the answer is a new snapshot rather than an edit. Editing would rewrite what was true at the time a problem was investigated, which is exactly the evidence the Memory exists to keep.

## D-020 — Environment conditions are one JSONB object (P1-07)

Conditions are stored in a single `jsonb` column rather than a column per field.

Which conditions matter differs by project and by problem. Columns would mean either requiring values nobody has, or a migration each time a new kind of condition appears. A JSON object keeps that open without widening the schema.

Only a JSON object is accepted — arrays and scalars are refused — enforced both in the application and by a database CHECK on `jsonb_typeof`, so the two cannot disagree. An empty object is allowed, because "the relevant conditions have not been captured yet" is a real state and a placeholder value would record something untrue.

This is not licence to store everything. The snapshot holds what is relevant to the problem, and is not a full dependency listing, a log store or a place for secrets. Search-oriented derivatives are built separately in a later phase rather than by widening this column's responsibility.

## D-021 — Owner and project consistency is enforced by a composite foreign key (P1-07)

Owner-scoped tables below Project carry `owner_id` directly as well as `project_id`, so owner scope can be enforced without a join.

Carrying both creates the possibility of disagreement, so it is closed in the database: `environments (owner_id, project_id)` references `projects (owner_id, project_id)`, which required adding a unique key on that pair in the P1-07 migration. The P1-06 migration was not modified. An environment pairing one owner with another owner's project cannot be stored, even by raw SQL.

The composite key also guarantees the owner exists transitively, since `projects.owner_id` already references `owners`, so a separate owner foreign key would add nothing.

Deleting a project that still has environments is refused (`on delete restrict`), following D-017. The full delete lifecycle is settled in P1-11.

A consequence worth keeping: creating an environment against an unknown project and against another owner's project both fail on the same missing pair, so the outcome cannot be used to discover whether someone else's project id is real.

## D-022 — Problem identity and required relations (P1-08)

`problem_id` is an application-issued UUID with no database default, consistent with the entities before it.

`environment_id` is required. A Problem always occurred under some set of conditions, and when those conditions have not been captured the Environment carries an empty snapshot — which P1-07 already allows. Making the column nullable would create a second way to express "not known yet", and the two would drift.

Owner, project and environment are checked as one triple by a composite foreign key to `environments (owner_id, project_id, environment_id)`, extending D-021 by one level. This required a unique key on that triple, added in the P1-08 migration without modifying P1-07. The environment's existence transitively guarantees the project's and the owner's, so no further foreign key is needed, and deleting an environment a Problem depends on is refused.

## D-023 — Problem text fields stay free-form in the MVP (P1-08)

`symptoms` is required `text`, not an array and not a structured shape. Several symptoms read perfectly well in prose, and fixing a symptom taxonomy now would commit to categories the retrieval work has not justified. Search-oriented features are derived separately in a later phase, so the stored Memory keeps the meaningful description rather than a parsed form.

`title` is required and non-blank: a Problem with no title cannot be recognised later, which defeats the point of recording it. Both are enforced in the application and by database CHECKs.

`problem_domain`, `suspected_boundary` and `source_ai` are nullable free-form text. Not knowing the domain or the suspected boundary at the start of an investigation is the normal case, and `source_ai` is nullable and unconstrained because manual and imported entries exist and no vendor's identifier shape should be baked in.

## D-024 — Problem initial values are set by the database, not the caller (P1-08)

A new Problem starts `INVESTIGATING`, confidence `LOW`, freshness `CURRENT`, reads and writes enabled, not suppressed, not important, `version` 1, with `fix_kind` null. These come from column defaults, and the creation input has no field for any of them.

Confidence starts at the lowest value because a new Problem has not been verified; assuming otherwise would let unverified Memory look trustworthy. `fix_kind` is null because at the start there is no fix, and `ROOT_FIX` / `WORKAROUND` is a separate axis from status rather than a later stage of it.

`importance` is a boolean. It is the user's "this matters" flag and is completely independent of confidence — important does not mean correct, and correct does not mean important. The specification gives no basis for a score or a scale, so none is invented; a wider type can be introduced by migration if evidence appears.

`version` exists from the start with a `>= 1` check so that Phase 2 can add optimistic locking without a backfill. Nothing increments it yet.

`updated_at` exists but has no trigger. Phase 2's update path sets it and `version` explicitly, so a write that forgets to is a visible bug rather than something a trigger quietly papers over.

## D-025 — VERIFIED enforcement and locking are Phase 2 (P1-08)

P1-08 establishes storage only. The schema does not attempt to make a Verification-less `VERIFIED` impossible at the database level, and there is no update path.

The state transition rules, including that `VERIFIED` requires at least one successful Verification, belong to P2-06, and optimistic locking to P2-07. Partially enforcing them here would produce a rule split across two layers with neither owning it.

## D-026 — Events are append-only (P1-09)

`event_id` is an application-issued UUID with no database default, consistent with the entities before it.

An Event records what was true at the moment it happened. There is no update path, no `updated_at`, no trigger and no application delete path. A later correction is another Event — that is what `USER_CORRECTION` exists for — so the record of how understanding changed is preserved rather than overwritten. Dead ends are kept for the same reason: knowing which direction did not work is half of what makes past experience reusable.

Owner and problem are checked as one pair by a composite foreign key to `problems (owner_id, problem_id)`, following D-021. This required a unique key on that pair, added in the P1-09 migration without modifying P1-08. Deleting a Problem that still has events is refused.

`summary` is required and non-blank: an Event with nothing to say records that something occurred without recording what. `result`, `reason` and `source_ai` are nullable free-form text, because not every kind of Event has a result or a reason, and manual, imported and user-corrected entries exist alongside AI-recorded ones.

## D-027 — Retry protection is keyed on (owner_id, client_event_id) (P1-09)

`client_event_id` is a required UUID the client mints before its first attempt and reuses if that attempt has to be retried. It is not optional: anything that can record a write can generate a UUID first, including manual entry, so making it optional would only lose the protection.

The append path never generates one itself. An id minted per attempt would be different on every retry and protect nothing.

Uniqueness is `(owner_id, client_event_id)`:
- Not per Problem, because a retry that lands against a different Problem is still the same client write and must not register twice.
- Not global, because that would couple separate owners' identifier namespaces for no benefit; two owners may independently generate the same value.

`ClientEventId` is a shared domain type rather than one per entity, since Verification writes need exactly the same guarantee.

P1-09 refuses a duplicate. Turning a duplicate into a replay of the original result — so a retry becomes a no-op rather than an error — is P2-04.

## D-028 — evidence_ref is a provider-independent free-form reference (P1-09)

`evidence_ref` is nullable text holding a pointer to supporting material: a repository path, a commit, an issue or PR, a test name, where a log was kept, an official document, a note about a device check.

It is a reference, not the material. Events are not a home for raw conversations, raw logs or code dumps, and widening this column would quietly turn them into one.

No URL type, no provider-specific format, and no structure for multiple references. Which of those shapes is needed is not yet known, and first-class structure can be introduced when a real need shows what it should be.

## D-029 — Event listing order is stable (P1-09)

Events are listed by `created_at` ascending, with `event_id` as a tie-breaker.

Timestamps can collide, and without a second key the order of colliding rows is whatever the database happens to return, which can differ between reads. The tie-breaker makes repeated reads agree. No sequence column is added: it is not in the specification, and the existing keys are enough.

Verifications follow the same rule, ordered by `created_at` then `verification_id`.

## D-030 — Verification is an entity independent of Event (P1-10)

A Verification is not the fix. It is the record of something actually checking whether the state holds, and it is a separate entity from the FIX Event that describes the change.

It attaches to the Problem directly, never to an Event. There is no `event_id` column, and the verification module imports nothing from the event module. A Problem may have a Verification and no Events at all, and that record still means exactly what it says — which is the point of separating them.

This follows the product invariant that an assistant reporting "it works" is not evidence that it does. A fix and a confirmation are different claims, and collapsing them would let the first pass as the second.

`verification_id` is an application-issued UUID with no database default. Verifications are append-only, like Events: no `updated_at`, no trigger, no update path. A later check is another Verification.

## D-031 — Verification result is a boolean (P1-10)

`result` is `boolean not null`. True means the check was carried out and confirmed the state; false means it was carried out and did not.

It is not free text, because P2-06 has to determine mechanically whether at least one successful Verification exists before allowing a Problem to become `VERIFIED`. Prose cannot be judged that way without inference, and this is precisely a decision that should not depend on it.

The account of what happened lives in `summary`, which is required and non-blank. A failed check is kept rather than discarded: it is evidence too.

`verified_by` is nullable free-form text naming who or what performed the check — a person, a test runner, CI, a build, a device operator, an assistant. It is not an enum and not tied to any vendor. Null when unknown, because a plausible-looking placeholder would misrepresent the evidence. It is distinct from `verification_type`, which is how the check was done, and from `evidence_ref`, which is where to look.

`evidence_ref` follows D-028 unchanged: a reference to material, never the material.

## D-032 — client_event_id namespaces are per table (P1-10)

Verification reuses the shared `ClientEventId` type and the same `(owner_id, client_event_id)` uniqueness, but the constraint lives on the verifications table.

Event and Verification appends are separate logical writes, so the same value may exist once in each. Merging the namespaces would make a Verification retry collide with an unrelated Event, which is a different failure than the one the identifier is meant to prevent. In practice an adapter issues a distinct id per write.

If a single identifier spanning every kind of write is ever needed — an operation or request id — it will be added as its own concept rather than by overloading this column.

`ProblemNotAvailableError` and `DuplicateClientEventIdError` live in `src/db/errors.ts`, shared by both append paths so that neither module depends on the other.

## D-033 — Recording a Verification does not change Problem status (P1-10)

Appending a Verification with `result = true` does not move the Problem to `VERIFIED`, and there is no trigger preventing `VERIFIED` without one.

Deciding a Problem is solved is a domain judgement, made in P2-06 after checking that a successful Verification exists. Making it a side effect of a write would put the rule in the storage layer, where it could not account for the rest of the transition rules, and splitting it across both layers would leave neither owning it.

## D-034 — RESTRICT is the schema-wide delete policy (P1-11)

Every foreign key in the schema deletes with `restrict`. This is now a stated policy rather than five separate per-table decisions, and it is confirmed by a catalog test rather than by convention.

Memory is the user's history and evidence. Deleting a Project must not take its Environments, Problems, Events and Verifications with it as a side effect — the value of the record is precisely that it survives. Cascade would make an entire subtree removable by one statement that does not mention it.

No cascade, and no trigger that simulates one.

RESTRICT does not make removal impossible, only implicit removal. A deliberate hard delete performs the deletions in order, from the leaves up: Events and Verifications, then Problem, Environment, Project, Owner. The integrity test exercises that order to keep it demonstrably possible.

The hard-delete service itself is not implemented here; it belongs to a later phase. Export is not a precondition for deletion — that would be a separate policy decision, and inventing it now would constrain a workflow that has not been designed.

## D-035 — Initial index set (P1-11)

Indexes exist for the access paths the code actually has, not for paths it might acquire.

- `events (owner_id, problem_id, created_at, event_id)` — one index covering the list query's filter and its sort together, per D-029's ordering
- `verifications (owner_id, problem_id, created_at, verification_id)` — the same shape
- `problems (owner_id, project_id, created_at, problem_id)` — listing a project's problems in order
- `problems (owner_id, project_id, environment_id)` — kept: it serves the environment foreign key and its RESTRICT check, a different path from the one above

Where an ordered index replaced a shorter one on the same leading columns, the shorter one was dropped rather than kept alongside. Its left prefix is still served, and two indexes leading with the same columns cost a write on every insert for nothing.

The same reasoning removed two indexes the audit found redundant against a unique index's left prefix: `projects (owner_id)` and `environments (owner_id, project_id)`. A test now fails if any index on a table is a left prefix of another on that table.

Vector, embedding and full-text indexes belong to the retrieval phase. Planner behaviour is deliberately not asserted: on a small test database a sequential scan is often the correct choice, so a test demanding an index scan would be testing the planner rather than the schema.

## D-036 — P1-11 is a review, not a feature (P1-11)

P1-11 added no entity, value set, column, API or repository abstraction. The audit found the foreign keys, delete actions, `client_event_id` uniqueness and NOT NULL policy already correct, so the migration changes only indexes.

Nullable columns were left nullable. Tightening one because it looks safe would encode an assumption the entity task deliberately avoided: those values can genuinely be unknown.
