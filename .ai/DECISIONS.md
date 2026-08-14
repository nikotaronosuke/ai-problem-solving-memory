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

## D-037 — The repository is an owner-scoped instance (P1-12)

`MemoryRepository` is created for one owner by `createMemoryRepository(executor, ownerContext)`, and none of its methods takes an owner argument.

The layer below takes an `OwnerContext` per call because it has no other way to know whose data it is handling. Making that a property of the object instead means the question is answered once, when the repository is built, rather than at every call site where it could be got wrong. Service code works with an already-scoped repository rather than passing an owner into each query.

Because an `OwnerContext` can only come from `resolveOwnerContext`, which verifies the owner exists (D-014), holding a repository is itself evidence that ownership was settled before any data was touched.

The surface is the Phase 1 minimum: create/get Project, create/get Environment, create/get Problem, append/list Event, append/list Verification. Listing, updating, deleting, searching, Relation, UsageLog, ChangeLog and transaction helpers are Phase 2, and adding them now would commit to shapes the service layer has not asked for.

## D-038 — The repository is a facade, not a second implementation (P1-12)

Every repository method delegates to the existing database function unchanged. No SQL is written in the repository layer, and PostgreSQL error codes are not reinterpreted there.

Error mapping stays where the error arises. Two layers both deciding what a constraint violation means is how they end up disagreeing, and the database layer already has the constraint names.

Record and input types are re-exported rather than redefined. Duplicating them into repository-specific shapes would leave two definitions of the same thing to keep in step, and they would not stay in step.

## D-039 — DatabaseExecutor is the minimal database boundary (P1-12)

Entity access takes a `DatabaseExecutor` — an interface with `query` and nothing else — rather than a pool.

Running a statement is all those functions ever needed. Requiring a pool additionally demanded the ability to open connections, count them and shut them down, none of which they use, and that surplus is exactly what would have prevented them working inside a transaction.

`DatabasePool` still exists for pool lifecycle and satisfies the interface, so a pool can be passed wherever no transaction is involved. `createPool` and `closePool` are unchanged, and health remains a pool-level probe.

The repository does not own a transaction: no `begin`, no `commit`, no `connect`. A service that needs one checks out a client, begins, and builds a repository over that client. This is what keeps P2-07's optimistic locking from requiring the repository to be rebuilt.

## D-040 — Layering is enforced by a test, not by convention (P1-12)

The dependency direction is domain ← service/API ← repository ← db ← PostgreSQL, and `tests/architecture.test.ts` checks it against the source.

It verifies that `src/domain/` imports nothing from `pg`, Supabase, `src/db/` or `src/repository/` and contains no SQL; that the repository writes no SQL and imports no driver; that the repository's public surface exposes no pool or client type; and that `pg` is named only in `db/config.ts`, `db/executor.ts` and `db/pool.ts`.

A layering rule that is only written down erodes quietly. This one fails the build instead.

## D-041 — Integration tests are self-contained and repository-driven (P1-13)

The Phase 1 scenario exercises the normal path entirely through `MemoryRepository`. Raw SQL is confined to test-only helpers: probing constraints the repository cannot express — an invalid enum value, a foreign key violation — and cleaning up afterwards.

That split is the point. Reaching into the database for a step the application would perform through the repository would test the schema while claiming to test the flow, and the two can drift apart without anyone noticing.

Fixtures generate their own owner on every run, depend on no bootstrap owner or previous run, and remove only what they created, leaf to root. A test that assumed an empty database or a particular developer's owner id would pass on one machine and fail on another, which is worse than not having it.

## D-042 — Fastify 5 is the HTTP transport (P2-01)

Fastify 5 is the only runtime dependency added; `pg` and Fastify are now the entire runtime surface.

Request and response validation use Fastify's built-in JSON Schema with Ajv rather than a separate validation library. Schemas are fixed application code — none is ever accepted from outside and compiled — so the input surface cannot be extended by a caller.

Ajv is configured to neither coerce types nor remove unknown properties. Silent removal is the worse failure: a client that sends a field it believes was honoured, and was actually discarded, has no way to find out.

Building an app and running one are separate. `buildMemoryHttpApp` returns an instance and starts nothing — no listener, no pool, no signal handler — which is what lets tests exercise the real application through `inject()` instead of a port, and keeps pools and signals in the composition root where they belong.

## D-043 — API versioning and JSON contract (P2-01)

The Memory JSON API is served under `/v1`. `/health` sits outside any version prefix, because whether the process is serving is an operational fact, not part of the API contract, and should not move when that contract does.

No header negotiation and no query-parameter versioning. A path prefix is legible in a log, a curl command and a bug report, and the alternatives are worth adding only when a real second version exists.

The JSON contract is snake_case, matching the canonical wording used throughout the specification (`owner_id`, `client_event_id`). Internal records are camelCase and are never serialised straight out: letting them through would turn an implementation detail into a public contract by accident, and would then be expensive to change. Every response is shaped explicitly and has a response schema.

## D-044 — One error envelope (P2-01)

Every failure returns `{ error: { code, message }, request_id }`. Clients branch on `code`, never on prose or on a status code alone.

The initial codes are `INVALID_REQUEST`, `UNAUTHENTICATED`, `NOT_FOUND` and `INTERNAL_ERROR`. More are added when a caller genuinely needs to act differently; a taxonomy invented in advance ends up describing the framework rather than the product.

Fastify and Ajv error objects do not cross the boundary. Returning them would make an internal library part of the public contract, and their text names Ajv keywords and JSON pointers that mean nothing to a client of this API.

An internal error returns no stack trace, driver message, connection string or file path. The full error goes to the log; the response says only that something failed.

## D-045 — Authenticated request context is owner-scoped (P2-01)

Transport does not resolve owners. A `preHandler` on the `/v1` scope calls the application request-context service, which resolves the owner and returns an `AuthenticatedRequestContext` carrying an owner-scoped `MemoryRepository`.

A handler therefore never sees an owner id it could pass somewhere, and never calls `resolveOwnerContext` itself. Owner scope is a thing it holds, not a value it must remember to forward — which is the difference between a boundary and a convention.

**An owner id is not a credential.** Nothing accepts one from a header or a body and treats the request as authenticated. Knowing an identifier is not the same as being that person, and wiring it up as a temporary measure is precisely how that distinction gets lost. Real client credentials, their issuance and their revocation are P3-04; this phase reuses the local `MEMORY_OWNER_ID` identity from P1-05, behind a single function to swap.

Missing, malformed and unknown owners are distinguishable in the log and identical in the response — one 401 with the same body. Otherwise the endpoint answers "does this owner exist?" for anyone who asks, which is the same existence oracle the storage layer was careful to avoid.

## D-046 — Transport depends on application services, not storage (P2-01)

`src/http/` imports no `pg`, no Supabase and nothing from `src/db/`, and contains no SQL. It depends on `src/app/`, which owns decisions about what a client may learn — a health probe reports unavailable without saying why, because the reason can name a host or a driver.

The direction is domain ← application ← transport, with repository and db beneath, and `tests/architecture.test.ts` enforces it rather than documenting it.

That test's import detector now recognises single-quoted, double-quoted, side-effect and dynamic imports. It previously matched only single-quoted static imports, so a violation written any other way would have been reported as clean — worse than not checking, because it looks checked.

## D-047 — Server binds to loopback by default (P2-01)

`HOST` defaults to `127.0.0.1` and `PORT` to `3000`.

This is a personal server holding one person's memory. Reaching the network should be something someone decided, not something a default did quietly — the same reasoning as D-011, where the local stack's exposure was accepted only because it was understood.

A blank `HOST` is refused rather than treated as loopback: an empty value is far more likely to be a broken deployment script than a request for the safe option, and defaulting it would hide the mistake. `PORT` must be digits within 1–65535, checked by pattern rather than numeric coercion, because `Number()` accepts `'3000.5'`, `'0x0bb8'` and `'3e3'`.

Credential headers — authorization, cookie, api-key, proxy-authorization, set-cookie — are redacted by the logger, and request bodies are not logged. The failure mode is silent: a credential written to a log once is a credential in a file nobody thinks to check.

## D-048 — Project and Environment route shape (P2-02)

Projects are a top-level collection: `POST /v1/projects`, `GET /v1/projects`, `GET|PATCH /v1/projects/:project_id`.

Environments are created and listed under their project — `POST|GET /v1/projects/:project_id/environments` — so the project id has exactly one source. Accepting it in both a path and a body would create a state where the two disagree, and someone would then have to decide which wins. A single environment is read by its own id, `GET /v1/environments/:environment_id`, because an environment id already identifies one record.

There is no delete anywhere in this phase, and no Environment update: an Environment is a point in time, per D-019, and changed conditions are a new snapshot.

## D-049 — Project update is partial and never upserts (P2-02)

`PATCH` carries only the fields being changed. An absent field is left alone; an explicit `null` clears `repo` or `platform`; a blank string normalises to null, matching D-018.

`owner_id`, `project_id`, `created_at` and `updated_at` are refused rather than ignored, along with any unknown field. Silently dropping them would let a caller believe it had set an owner.

An empty patch is refused at the schema and again in the application layer. It would still move `updated_at`, recording a change that did not happen — and the second check exists because the first only protects the HTTP path.

The update is scoped by owner and never inserts. Patching an unknown or another owner's id is a 404 that creates nothing, so a mistyped id cannot quietly produce a record.

`updated_at` is written explicitly in the statement rather than by a trigger, following D-024: a write that forgets it should be a visible bug.

## D-050 — Lists are ordered in SQL and unfiltered (P2-02)

Both list endpoints order by `created_at` then the resource id, in the query itself. Timestamps collide, and without a second key the order of colliding rows is whatever the database returns, which can differ between reads — the same reasoning as D-029.

No pagination, filtering or search in this phase. Adding them before there is a caller would fix a shape that the retrieval work has not yet justified.

## D-051 — Not-found is unified, and checked before listing (P2-02)

The application layer raises one `ResourceNotFoundError` whether a resource does not exist or belongs to another owner, and transport renders both as the same 404 body. Distinguishing them would answer "does this id exist?" for anyone who asks — the existence oracle the storage layer was built to avoid.

Listing a project's environments verifies the project first. Returning an empty list for a project that is not the owner's would say "it exists and has none", which is both untrue and a small leak. An owner's own project with no environments still returns an empty list, which is the honest answer.

Transport maps application errors by type and never names a database error class; the architecture test enforces that, so PostgreSQL cannot become part of the HTTP contract by accident.

## D-052 — The snapshot boundary is the HTTP schema (P2-02)

`snapshot` is accepted only as a JSON object at the top level, with unconstrained keys inside. An array, string, number, boolean or null is a 400 before the request reaches the domain.

The domain converter is unchanged. It accepts any non-array object, which is correct for its own layer, and the HTTP boundary is where the narrower rule belongs: what arrives there is parsed JSON, so the shapes the converter cannot describe cannot appear.

## D-053 — Problem route shape (P2-03)

Problems are created and listed under their project — `POST|GET /v1/projects/:project_id/problems` — for the same reason Environments are (D-048): the project id has one source and cannot disagree with itself. A single Problem is read and patched by its own id, `GET|PATCH /v1/problems/:problem_id`, which already identifies one record.

There is no unscoped `/v1/problems` collection and no delete, matching the rest of the phase.

Creation names an environment in the body. That environment must exist, belong to the caller, and belong to the project in the path. All three failures, plus an unknown or another owner's project, produce one 404 with one body — five reasons, one answer, so the endpoint cannot be used to discover which ids exist.

## D-054 — A new Problem's starting state is the database's, not the caller's (P2-03)

D-024 settled this for storage; this is the HTTP boundary keeping it true. `status`, `fix_kind`, `importance`, `confidence`, `freshness`, the two memory flags and `version` are not accepted on create. They come from the column defaults established in P1-08: `INVESTIGATING`, no fix kind, low confidence, current, readable and writable, not suppressed, version 1.

A caller that could declare these could file a Problem that arrives already `VERIFIED` and trusted, which is exactly the claim the verification rules exist to make earnable. Sending one is a validation failure rather than a silently ignored field.

## D-055 — What a Problem patch may change (P2-03)

Eleven fields: `title`, `symptoms`, `problem_domain`, `suspected_boundary`, `source_ai`, `importance`, `confidence`, `freshness`, `memory_read_enabled`, `memory_write_enabled`, `suppressed`. Partial semantics follow D-049 — absent leaves alone, `null` clears a nullable field, blank normalises to null, an empty patch is refused twice, and it never upserts.

`status` is absent because state transitions are P2-06's and `VERIFIED` requires a successful Verification (D-025, D-033). A generic field assignment would walk straight past that rule, and a rule that a later task is meant to enforce would already have been given away.

`fix_kind` is absent because it belongs with close and review in P2-12, and `version` because P2-07 turns it into an optimistic lock — until then it is response-only, and there is no `expected_version`.

The identifiers and timestamps are refused as before. None of the three exclusions is an oversight, so adding one here would be removing a guarantee.

## D-056 — The Problem flags are independent of each other (P2-03)

`importance`, `confidence`, `freshness`, `memory_read_enabled`, `memory_write_enabled` and `suppressed` are stored and changed one at a time. Setting one never moves another, and every combination is representable.

The tempting couplings are all wrong. Important does not mean correct, so marking a Problem important must not raise confidence (D-024). Suppressing means "surface this less", not "do not read this", so it must not disable reads. Going stale is a fact about the memory, not an instruction to hide it. Deriving any of these from another would replace the user's judgement with a guess, and the guess would be unrecoverable — there would be no way to say "important but still unproven".

## D-057 — Event route shape (P2-04)

Both routes are nested under the problem: `POST|GET /v1/problems/:problem_id/events`. The problem id has one source, as with Environments under a Project (D-048).

There is no single-event read, no update, no delete and no unscoped `/v1/events`. Events are append-only (D-026), and a route that reads one event by id would exist only to be followed by a route that edits it.

`problem_id`, `owner_id`, `event_id` and `created_at` are refused in the body. The problem comes from the path; the other three are the server's. Append and list both confirm the problem is the caller's before doing anything, so listing another owner's problem is a 404 rather than an empty list — an empty list would say "it exists and has none".

## D-058 — An Event retry returns the original, and the first write wins (P2-04)

D-027 left this open: P1-09 refused a duplicate `client_event_id`, and P2-04 was to decide what a retry should do instead. It returns the event the first attempt wrote, with 201 and the same body as the original response. A client that never learned whether its request arrived can send it again and get a definite answer either way, which is the whole point of the identifier.

The status does not change between the first attempt and a retry. Distinguishing them would tell the client something it cannot act on and did not ask about — it wanted the event, not the history of its own connection.

If the retry's payload differs, the original is still returned, unchanged. Applying the new payload would edit an append-only record. Creating a second event would hide the fact that the client reused a key by mistake, which is a client bug worth surfacing rather than absorbing.

The namespace is `(owner_id, client_event_id)`, not the problem, so a retry aimed at a different problem replays the original — including its `problem_id`, which is how the client sees what it actually did. Ownership of the problem in the path is confirmed first regardless: the unique index is evaluated before the foreign key, so an unchecked append could otherwise replay an event to someone with no right to it. Idempotency is never the route past owner scope.

## D-059 — The unique constraint arbitrates the race, in the database layer (P2-04)

The append attempts the insert and reads the original back only after the unique index refuses it. Reading first and inserting if nothing was found leaves a window where concurrent attempts all find nothing and all insert; the constraint is the only thing that can decide between simultaneous writers, so it is what decides.

An integration test sends the same key six times at once and asserts one event and one `event_id`. It opens the pool's connections first — otherwise the earlier attempts finish while the later ones are still connecting, and nothing races. It was confirmed to fail against a read-then-write append before being kept.

The handling lives in `src/db/events.ts`. The application layer does not catch `DuplicateClientEventIdError` and transport does not know the name; the architecture test now enforces that for `src/app` as well as `src/http`. A service that caught it would be deciding storage behaviour from the one place that cannot see a concurrent writer.

One consequence of a failed insert is an aborted transaction. That is fine while each statement is its own implicit transaction, and a savepoint will be needed if the append is ever called inside an explicit one.

## D-060 — Event and Verification replay arrive separately (P2-04)

Only Events replay. A duplicate Verification `client_event_id` is still refused, and P2-05 changes that.

The two were not done together on purpose. `client_event_id` namespaces are per table (D-032), so the paths are independent, and changing the shared error's meaning for both at once would make P2-05 a rename rather than a decision — including the question of what a Verification retry means when the original recorded a different `result`. Until then the difference is deliberate and is asserted by a test, so it reads as a decision rather than an oversight.

## D-061 — Verification route shape (P2-05)

`POST|GET /v1/problems/:problem_id/verifications`, mirroring the Event routes (D-057). No single-verification read, no update, no delete, no unscoped `/v1/verifications`.

There is deliberately no route reaching a Verification through an Event, and `event_id` is refused in the body. D-030 made the two independent in storage; this keeps them independent in the contract, so nothing can start treating a Verification as a property of the FIX Event that preceded it. A Problem with a Verification and no Events at all is still a coherent record, and a test asserts it stays one.

Both routes confirm the problem is the caller's first, so an unknown or another owner's problem is one 404 and listing never answers with an empty list for something that is not the caller's.

## D-062 — result is a boolean at the HTTP boundary too (P2-05)

D-031 made `result` a boolean in storage. The request schema keeps it one: `true` and `false` are accepted, and `null`, `"true"`, `"false"`, `1`, `0` and a missing field are each a 400 rather than something coerced. Type coercion is off application-wide, so this holds without special handling.

Both values mean a check was actually carried out — true that it confirmed the state, false that it did not. "Not checked yet", "unknown" and "not tried" are the *absence* of a Verification, not a Verification recording false. Every widening of this type would let that third meaning in through a value, and P2-06 has to be able to find a successful check mechanically.

A false result is kept and listed like any other. It is evidence too, and discarding it would leave "we checked and it failed" indistinguishable from "nobody checked".

## D-063 — A Verification retry cannot change what was found (P2-05)

Appending is idempotent on `(owner_id, client_event_id)` exactly as Events are (D-058): first write wins, the retry's payload is not applied, a retry aimed at a different problem replays the original including its `problem_id`, and ownership of the problem in the path is settled before the key is consulted.

`result` is why this matters more here than it does for Events. A retry is the same write arriving again, not a second check, so it cannot turn a recorded false into true — or true into false. Allowing it would let a client overwrite a finding by resending, which is precisely the failure the separation of fix from confirmation exists to prevent: an assistant saying "it works" is not evidence that it does. Tests fix both directions.

A different finding is a new Verification with a new key. There is no `USER_CORRECTION` here as there is for Events, because a second piece of evidence *is* the correction — and both remain visible, which is the honest record.

## D-064 — DuplicateClientEventIdError was removed rather than kept (P2-05)

With both append paths replaying, nothing raised it. It was deleted along with its re-exports from `src/db/index.ts` and `src/repository/index.ts`, rather than kept because it was once shared: an error type no code can produce is a claim about behaviour that no longer exists, and the next reader would have to prove that for themselves.

This supersedes the last paragraph of D-032, which described it as shared by both append paths, and completes what D-060 deferred.

Nothing about the constraints changed. `(owner_id, client_event_id)` is still unique per table, still the arbiter of concurrent retries, and still refuses a direct insert that goes around the append path — tests check that against the database rather than through the code that was just changed.

## D-065 — Recording a Verification still decides nothing (P2-05)

Appending a Verification with `result = true` leaves the Problem's `status` exactly where it was, including `INVESTIGATING`. There is no transition service, no status write and no version increment in this task.

D-033 settled this for storage; P2-05 is where an API could most easily have undone it, since this is the endpoint a client would call on being told a fix worked. Deciding a Problem is solved weighs the transition rules as well as the evidence, and P2-06 owns both. An integration test reads the status back through the API after a successful verification, so the guarantee is checked at the boundary a client actually sees.

## D-066 — Status changes through a route of its own (P2-06)

`POST /v1/problems/:problem_id/status-transitions`, with a body naming only `target_status`. The response is the whole updated Problem in the usual shape, at 200 — nothing was created.

Not a field on the Problem PATCH. `status` is not an attribute a caller asserts; it is the outcome of a move that either is or is not allowed from where the Problem currently stands, and `VERIFIED` additionally has to be earned. Expressing that as `PATCH {"status": ...}` would make an ordinary field assignment out of a rule, which is exactly what D-055 refused to allow. The PATCH schema still rejects `status`, and a test checks that adding this route did not widen it.

Posting a transition rather than putting a status, because what the caller is asking for is the move, and the move is the thing that can be refused.

The current status is not accepted in the body. It comes from the record, since taking both would let them disagree. `expected_version` is refused too — see D-069.

## D-067 — The transition matrix (P2-06)

Ten moves, and no others:

| From | To |
| --- | --- |
| `INVESTIGATING` | `FIX_CANDIDATE`, `PAUSED`, `CLOSED_UNRESOLVED` |
| `FIX_CANDIDATE` | `INVESTIGATING`, `VERIFIED`, `PAUSED`, `CLOSED_UNRESOLVED` |
| `PAUSED` | `INVESTIGATING`, `FIX_CANDIDATE`, `CLOSED_UNRESOLVED` |
| `VERIFIED` | — |
| `CLOSED_UNRESOLVED` | — |

A status may not move to itself: it would advance `updated_at` and record a change that never happened, which is the reasoning D-049 already applies to an empty patch.

`PAUSED` leads back to both working statuses, because setting work aside and picking it up again is the ordinary case rather than an exception.

`VERIFIED` and `CLOSED_UNRESOLVED` are terminal *for now*. Reopening a resolved or abandoned Problem is a real requirement with real questions attached — does the old evidence still count, is it even the same Problem — and adding a path here would settle them by accident. Until something asks for it, a renewed investigation is a new Problem.

The matrix lives in `src/domain/problem-status.ts` as data, with no knowledge of HTTP, storage or the repository. The architecture test now enforces that a problem status literal appears nowhere in `src/` outside the domain, so a route or service cannot decide part of the rule for itself and drift.

## D-068 — VERIFIED requires this Problem's own successful Verification (P2-06)

The rule D-025 deferred and the whole reason D-030 and D-031 exist. Moving to `VERIFIED` needs at least one Verification on this Problem whose boolean `result` is true.

Nothing substitutes for it. Not a `FIX` Event, not a summary that reads conclusively, not a high `confidence`, not a `fix_kind`, not a failed Verification, and not an assistant's report that something works — the last being the invariant the entity was separated out to protect. `result` is a boolean precisely so this is a mechanical check rather than an inference over prose.

Evidence is per Problem and per owner. The lookup goes through the owner-scoped repository keyed by problem id, so another Problem's or another owner's check is not reachable even by mistake. One case is worth naming because it looks like evidence and is not: a Verification retry aimed at a different Problem replays the original and returns 201 (D-063), while recording nothing against the Problem in the path. A test drives exactly that sequence and then asserts the transition is still refused.

`VERIFIED` is reachable only from `FIX_CANDIDATE`, even with evidence in hand. "We think this is the fix" and "we checked, and it holds" are two steps, and a Problem nobody has proposed a fix for cannot be confirmed fixed.

## D-069 — A transition moves the status and nothing else (P2-06)

`fix_kind`, `confidence`, `freshness`, `importance`, the memory flags, the text fields and the identifiers are all untouched. Verifying a Problem says the fix holds; it does not say anyone is more confident in the record, and it does not say whether the fix addressed the cause or worked around it — that is `fix_kind`, a separate axis (D-024), and P2-12's. Deriving one from the other would record a judgement nobody made, the same objection D-056 raises about the flags.

`version` does not move either. P2-07 owns what an increment means and introduces `expected_version`; incrementing here would imply a concurrency guarantee that does not exist, and accepting `expected_version` would imply one that is not enforced. Both are refused, and tests pin `version` across a successful transition.

There is also no compare-and-swap. Two callers transitioning the same Problem at once can both read the same status, both pass the rule, and both write; the last one wins. That is P2-07's to detect, and doing half of it here would leave neither task owning the guarantee.

A refused transition writes nothing at all — status, `updated_at` and every other field unchanged, checked by re-reading the whole record after the 400.

## D-070 — Every refusal is INVALID_REQUEST (P2-06)

A status not in the canonical set fails schema validation; a move outside the matrix, a move to the same status, a move out of a terminal status and a missing successful Verification are all refused by the rule. All of them answer 400 `INVALID_REQUEST`.

No new error code and no 409. P2-07 introduces the vocabulary for concurrency conflicts, and borrowing part of it now would leave two tasks describing the same thing differently. The domain reports a specific refusal reason for the log; the client gets the shared envelope, as it does for every other application-level refusal.

Unknown and cross-owner Problems answer 404 with an identical body, as everywhere else.

## D-071 — Every Problem write names the version it acts on (P2-07)

`expected_version` is required on both write paths: `PATCH /v1/problems/:problem_id` and `POST /v1/problems/:problem_id/status-transitions`. An integer from 1, refused rather than coerced — `"4"`, `4.5`, `0`, `true` and null are all 400, because a concurrency token that can be misread is not one.

Required rather than optional. Optional would mean the unsafe call is the shorter one, and a Problem is exactly the kind of record where two people or assistants work on the same thing: a silent overwrite loses a finding with nobody aware, which is worse than an error because it looks like it worked.

It is a token, not a field. `version` itself stays unwritable, and a body carrying only `expected_version` is refused — it changes nothing, so it would move `updated_at` and the version to record a change that never happened, the same objection D-049 raises to an empty patch.

This supersedes the part of D-055 that refused `expected_version` on the PATCH, and the part of D-069 that refused it on a transition. Both refused it because P2-07 had not yet decided what it meant; it now means this.

## D-072 — A successful Problem write increments the version; nothing else does (P2-07)

Both write paths increment, in the statement itself — `version = version + 1`, never assigned from a caller's value. Both share the one column, so an ordinary edit and a status transition conflict with each other. Two separate locks would let someone edit a Problem out from under a transition with neither noticing, which is the failure this task exists to prevent.

A refused write does not increment. Everything the earlier tasks refuse — an empty patch, a disallowed transition, the same status, a terminal status, a missing successful Verification — leaves the record untouched including `updated_at`, and tests check that by re-reading the whole record.

Events and Verifications are not versioned. They carry no `expected_version`, do not check the Problem's version and do not move it, so a Problem at version 5 accepts appends exactly as at version 1 — and an append still succeeds after a Problem write was refused as stale. Losing what was learned because the body of the record was contended would be the wrong trade. Their retry protection is `client_event_id` (D-058, D-063), which answers a different question: the same write arriving twice, not two writers overwriting each other.

D-069 said `version` does not move for a transition, which was true until this task; that is now superseded.

## D-073 — The database decides the conflict (P2-07)

The write is `update ... where owner_id = ? and problem_id = ? and version = ?`. The application also compares versions after reading, but the predicate is what settles it: reading and then updating without it leaves a window in which another writer lands in between and both callers believe they won. Only one statement can match a given version.

Three integration tests race real requests — two patches, two transitions, and a patch against a transition — and each asserts one 200, one 409, and a final version of exactly 2. They were confirmed to fail against a read-then-write append first, where all three produce two 200s and a lost update.

The zero-row result is what the application reads as a conflict, not a PostgreSQL error code. Nothing above the database layer inspects a driver error, so optimistic locking does not make PostgreSQL part of the HTTP contract.

There is no `for update`, no transaction and no retry. A conflict is reported to the caller, who is the one who can decide whether their change still makes sense against what is now there.

## D-074 — VERSION_CONFLICT is a fifth error code (P2-07)

409 with `{ "error": { "code": "VERSION_CONFLICT", "message": "Problem version conflict." } }`. It earns a code of its own because a client acts differently on it than on anything else: re-read the Problem and decide again. That is not a validation failure and not something the caller cannot act on.

The message names no version. A client already knows what it sent and can re-read to see where things stand; reporting the current number would hand out a fact about a record rather than about the request.

D-070 said P2-06 introduced no conflict vocabulary so that this task could own it whole. It does.

## D-075 — Ownership before version, and version before the rule (P2-07)

An unknown Problem and another owner's are still one 404, and that check comes first. A 409 for a Problem someone does not own would confirm it exists, and would let them search for its version — the existence oracle every other decision here avoids. Tests send both a right and a wrong version at another owner's Problem and expect 404 either way.

Within the caller's own Problems the version is checked before the transition rule is applied. A caller working from a stale read has a stale idea of the current status too, so judging its request against a status it has not seen would answer a question it did not ask — and could allow a move it would not have requested had it known. The useful answer is "read it again". Schema validation still comes before both, so a malformed request is a 400 regardless.

## D-076 — A Relation links two Problems, and only two Problems (P2-08)

`relations` holds `relation_id`, `owner_id`, `from_id`, `to_id`, `relation_type`, `reason`, `created_at`. Both ends reference `problems (owner_id, problem_id)`, so a link is between two Problems of one owner and nothing else.

No `from_type` / `to_type` and no polymorphic target. Patterns and Skills do not exist, and a schema built for entities nobody has defined would fix their shape before anyone knows it — the same reasoning that kept `evidence_ref` free-form text in D-028.

No `updated_at`, no `version` and no `client_event_id`. There is no update path, so nothing records a change or guards one; and whether a retried link needs an idempotency key — including what "the same link" means when the reason differs — is a real question this task does not answer. Copying `client_event_id` across from the append paths would have answered it by reflex.

`reason` is required and non-blank, in the domain and in a CHECK. A link nobody can account for later is a link nobody can act on, and "these two look alike" is exactly the judgement that needs its reasoning attached. Free text rather than a taxonomy, for D-023's reason.

The CHECK names the whitespace characters explicitly — one-argument `btrim` strips spaces only, so a tab-only value would pass a check written the way the earlier tables' are. Those are left as they are; the application trims all whitespace before writing, so the gap is not reachable through the API.

## D-077 — Six relation types, one row per link (P2-08)

`SIMILAR_TO`, `RELATED_TO`, `CAUSED_BY`, `SUPERSEDES`, `DERIVED_FROM`, `CONTRADICTS` — the set the specification names, as a text-backed DOMAIN like the six before it (D-012), registered in `ENUM_DOMAIN_BINDINGS` so the drift test covers it.

Three carry direction: `from` was caused by, supersedes, or derives from `to`. Three read the same both ways. Either way exactly one row is written — no mirror row for the symmetric types. Two rows would have to be kept in step by something, and nothing would keep them in step.

Rows are reported as stored, never flipped to suit whose list is being read. A link recorded as A supersedes B reads that way from B's list too; reversing it would state the opposite of what someone recorded.

Listing a Problem's relations returns both ends — `from_id = ? or to_id = ?` — with an index per side. Otherwise "what does this relate to?" would answer differently depending on which end someone happened to record the link from, which is not a difference a reader should have to know about.

## D-078 — Links cross projects, never owners, and never join a Problem to itself (P2-08)

Cross-project is the point. A problem solved in `checkout-web` informing an investigation in `admin-console` is what makes this memory worth keeping across projects at all, and confining links to one project would rule it out.

Cross-owner is refused twice: the application checks both ends against the owner-scoped repository, and both foreign keys check the `(owner, problem)` pair. The application check is not redundant — the answer a client gets should be a decision made at that layer rather than a consequence of which constraint fired, and both ends must fail identically. Another owner's Problem and one that does not exist produce the same 404, so the endpoint cannot be used to ask whether an id is real.

Self-links are refused in the application and by a CHECK. A Problem is not similar to, caused by or a replacement for itself under any of the six meanings, and the self-loop would be something every later traversal had to special-case. The rule takes no relation type, because it does not depend on one.

## D-079 — A Relation is a link, not an inheritance (P2-08)

Creating one changes neither Problem. No status moves, no version increments, no `updated_at` advances, and nothing — confidence, freshness, importance, the flags, Events, Verifications — is copied across.

Most of all, evidence does not travel. Relating a Problem to a `VERIFIED` one does not let it become `VERIFIED`: it still needs a successful Verification of its own, per D-068. Being similar to something that was checked is not the same as having been checked, and a link is exactly the kind of claim someone could otherwise use to launder one into the other. An integration test drives that whole sequence and asserts the second Problem is still refused.

Because it is not a write to either Problem, there is no `expected_version` (D-071 applies to Problem writes, and this is not one). Sending one is a 400.

## D-080 — Create and list, and nothing else yet (P2-08)

`POST` and `GET /v1/problems/:problem_id/relations`. No single-relation read, no update, no delete, and no unscoped `/v1/relations`.

The source Problem comes from the path only, so it has one source and cannot disagree with a body field — the reasoning D-048 applies to nesting generally.

How a mistaken link is corrected or withdrawn is deliberately undecided. Events and Verifications are append-only because a later correction is another record; Problems are updatable and versioned. A Relation is neither obviously one nor the other, and adding a route now would settle it by accident rather than by decision.

No graph traversal, no automatic similarity detection, no deduplication and no pagination. Retrieval is a later phase, and building for it now would fix shapes that phase has not justified.

## D-081 — UsageLog is Memory-specific history, not a global audit log (P2-09)

`usage_logs` records that a past Problem was used while working on another: found, read, taken, set aside, or decisive enough to change the approach. Separate from the Memory itself, per the specification — a Problem records what was learned, and this records that someone consulted it. Folding them together would make the record of an investigation depend on who has been reading it.

It records nothing wider. No tool calls, deploys, model invocations or approvals, and no columns for them. The boundary addendum places a Global Audit Layer outside this repository, and the way to keep that true is for this table to stay something such a layer could read from rather than something already trying to be it. Tests assert the absence of `tool_id`, `model_id` and `approval_id`, and that `/v1/audit-logs` is not served.

## D-082 — memory_id is a Problem, and may be the same Problem (P2-09)

In the MVP a Case Memory *is* a Problem, so `memory_id` is a plain composite foreign key to `problems (owner_id, problem_id)` — the same shape as `problem_id`. No `memory_type`, no `entity_type`, no polymorphic target: Patterns and Skills do not exist, and columns added for them now would fix their shape in advance, as D-076 says of Relations.

`problem_id` is the problem being worked on; `memory_id` is the past one drawn upon. They may be equal, and there is deliberately no self-check — continuing the same investigation under a different AI, reading back its own history, is a real case and refusing it would gain nothing. This differs from a Relation, where a self-link is refused (D-078), because the two record different things: one asserts that two problems are related, the other that something was consulted.

Cross-project is allowed and cross-owner is refused, for D-078's reasons and by the same double check — the application against the owner-scoped repository, and both foreign keys.

## D-083 — Five actions, no order between them (P2-09)

`SEARCHED`, `REFERENCED`, `ADOPTED`, `EXCLUDED`, `CHANGED_STRATEGY`, as a text-backed DOMAIN like the seven before it (D-012) and registered in `ENUM_DOMAIN_BINDINGS`.

They are observations, not stages. Nothing requires `SEARCHED` before `REFERENCED` or `REFERENCED` before `ADOPTED`, and nothing in the domain relates one to another. An adapter reports what it can tell — some never see a search step, some only realise at the end that a memory changed the direction of the work — and a required sequence would turn a record of what happened into a workflow that adapters would have to satisfy with invented entries.

## D-084 — Logging is explicit; no read writes one (P2-09)

A usage log is created only by calling the endpoint. Fetching a Problem, or listing its Events, Verifications or Relations, writes nothing.

Two reasons. A read that quietly writes can fail for reasons the caller never asked about, and Memory trouble must not stop the work it is meant to support. And a read is not a use: only the adapter knows whether it referenced a memory, adopted it, or set it aside, so only the adapter can say. An integration test performs every read a caller might make while consulting a memory and asserts nothing was recorded.

## D-085 — source_ai describes; it never authorises (P2-09)

Required and non-blank, free-form text: provider and model names change, and manual and imported entries exist alongside AI ones — the same reasoning that keeps `source_ai` free-form on an Event (D-026).

It is not a credential and is never consulted for scope. The owner comes from the established request context and from nowhere else, as it has since D-014. A test sends another AI's name, `manual`, another owner's id and `root` in that field and asserts each reaches exactly the same data — a 404 for the other owner's Problem in every case.

## D-086 — Using memory is not a claim about it (P2-09)

Creating a usage log changes neither Problem: no status, no version, no `updated_at`, no confidence or freshness, and no Relation, Event or Verification appears. So there is no `expected_version` — this is not a Problem write (D-071 governs those) — and sending one is a 400.

Adopting a `VERIFIED` memory does not let the current Problem become `VERIFIED`. Memory is a candidate, not an answer, and the evidence rule (D-068) is unaffected by how many memories were consulted. A test drives that sequence and asserts the transition is still refused.

Create and list only, with the list scoped to the problem being worked on: "what did this investigation draw on?" is the question. "Where has this memory been used?" is a different one, and the index for it exists but no endpoint asks it yet.

Retention and correction are deliberately undecided. There is no update or delete path, but that is not a promise that usage history is kept forever — deciding that belongs with whatever privacy and export work comes later, not with the table that first stores it. No idempotency key either: whether a resent log needs one is a question for when adapter retry behaviour is designed, and copying `client_event_id` across from the append paths would answer it by reflex.

## D-087 — Change history is written by the service, never by a caller (P2-10)

A successful Problem mutation records its own history. There is no `POST` for a change log entry, no `PATCH`, no `DELETE`, and no field of an entry comes from a request body: the versions come from the mutation, the owner from the established context, the time from the database. A history a caller can author is not a history, and one it can edit afterwards is worth less than none.

Not a trigger either. What may be recorded is a product decision — some values exactly, some deliberately not — and a trigger would have neither the context to tell them apart nor anywhere to say why.

Only the two mutable Problem paths are tracked: the ordinary `PATCH` and the status transition. Creating a Problem, appending an Event or Verification, linking a Relation and recording usage all leave the history untouched. Those are either creations or append-only records that already are their own history; a change log for them would restate what the row already says.

## D-088 — The change and its record are one transaction (P2-10)

Both mutating services run inside `runInTransaction`, and the change log insert happens there. A Problem edited with no record of it, and a record of an edit that did not happen, are both worse than the write failing outright.

This is the first thing that genuinely needed more than one statement to succeed together, and it is what `DatabaseExecutor` was shaped for since D-039. `DatabaseTransactionRunner` in `src/db/transaction.ts` checks out a client, begins, and commits — or rolls back if the work throws, which means an unexpected failure rolls back too rather than needing to be anticipated. `pg` stops there: the application layer sees `runInTransaction(work)` handed an owner-scoped repository, so a service still cannot name an owner or reach a connection.

The transaction does not replace the compare-and-swap. The version predicate on the update is still what arbitrates a race (D-073); the transaction is what keeps the record with the change. Two integration tests inject a failing `createChangeLog` at the seam the service already uses and assert the Problem is unchanged — version, fields and `updated_at` — and both were confirmed to fail against a non-transactional context first.

## D-089 — One entry per mutation, bracketed by versions (P2-10)

A patch that changes five fields is one thing that happened, so it is one entry naming five fields. `from_version` and `to_version` bracket it, and a CHECK requires them to differ by exactly one — a successful mutation moves the version by one, so anything else describes something that could not have occurred.

`(owner_id, problem_id, to_version)` is unique. The compare-and-swap already means only one writer produces a given version; the constraint states that in the schema so a second entry claiming it is refused rather than silently accumulating. No history is reconstructed for Problems that changed before P2-10 — an invented past is worse than an admitted gap.

A refused mutation records nothing: a stale version, a disallowed transition, a missing successful Verification, a patch with nothing to change, a problem that is not the caller's. Throwing inside the transaction rolls it back, so this needs no separate handling.

Same-value writes are recorded honestly. Writing `LOW` over `LOW` still moves the version, so an entry is owed, and it says the value did not move rather than pretending the field was untouched. P2-10 did not change what the mutation endpoints accept.

## D-090 — Free text is described, never copied (P2-10)

Controlled values — `status`, `fix_kind`, `importance`, `confidence`, `freshness`, and the memory flags — keep their before and after exactly. They come from closed sets, they are what shows how judgement about a Problem changed, and a value from a fixed list cannot be a secret.

Free text — `title`, `symptoms`, `problem_domain`, `suspected_boundary`, `source_ai` — is not copied. An entry records that the field was part of the change, whether it went from or to absent, and whether the value actually differed. Nothing else.

The reason is the one the specification names: a value removed from a Problem later must not survive in its history. A copy here would outlive the removal and quietly defeat it, and complete deletion is a real requirement rather than a hypothetical one. Tests write deliberately distinctive strings and assert they appear nowhere in the stored `changes`, read straight from the table.

`fix_kind` is listed although nothing writes it yet: when close and review arrive they will move it, and deciding its treatment now is better than leaving it to whoever adds the write. A field with no decided treatment is ignored rather than copied by default.

## D-091 — changed_by is required, and describes rather than authorises (P2-10)

Both Problem write paths now require `changed_by`, free-form and non-blank. A history that cannot say who changed something answers half the question it exists to answer, and there is no other source for it — the owner identifies whose data it is, not which assistant or person acted.

Free-form for the reasons `source_ai` is (D-026, D-085): assistant and tool names change, and manual edits exist alongside automated ones.

It is never consulted for authorisation. A test writes another assistant's name, `manual`, another owner's id and `root` into the field and asserts each reaches exactly the same data — a 404 for the other owner's Problem in every case. It is also not a Problem field: it lives in the history and nowhere else.

`expected_version` plus `changed_by` alone is refused, as an empty patch was before (D-071): a token and a signature are not a change.

## D-092 — Basic modification stays the ordinary Problem update (P2-11)

P2-11 lists "basic modify" among its work, and `PATCH /v1/problems/:problem_id` already is it. No `/modify` or `/basic-modify` route was added, and nothing was removed from the generic patch to make room for the control surface — it still accepts the memory flags and `freshness`, so anything written against it keeps working.

The controls got a surface of their own because they are decisions about how a memory should be *used*, not edits to what it says. That is worth naming at the API rather than leaving as three booleans among eleven fields. Both surfaces edit the same record and go through the same path.

## D-093 — Memory controls run through the existing mutation path (P2-11)

`applyProblemMutation` in `src/app/problem-mutation.ts` now holds what a Problem field change means: existence before version, compare-and-swap on the version the caller named, change and history in one transaction. The ordinary update and the control route both call it.

Extracted rather than copied. Two surfaces with their own locking is how one of them ends up subtly weaker, or quietly not recording history, and the difference would not show until something was lost. Status transitions keep their own flow — they apply a rule first and write a different column — but follow the same guarantees.

Nothing new below the application layer: no migration, no column, no domain, and the repository stays at twenty-two operations. A dedicated `updateMemoryControl` would have been a second write path to the same fields with nothing to justify it.

## D-094 — The four control axes are independent (P2-11)

`memory_read_enabled`, `memory_write_enabled`, `suppressed` and `freshness` are set only when named, and no control implies another. Turning off reads does not suppress; suppressing does not invalidate; invalidating disables nothing.

The specification names keeping suppression and `INVALID` apart as a completion condition, and the reason generalises: "surface this less", "do not read this automatically" and "this turned out to be wrong" are different facts. A retrieval layer will want to act on them differently — an invalid memory might be worth surfacing as a warning, while a read-disabled one is simply absent — and a coupling introduced now would foreclose that. Collapsing them into one `disabled` state, or adding a field that means several at once, would lose distinctions that already exist.

Every integration test that sets one control asserts the other three did not move. The failure mode here is not an error but a plausible-looking coupling, which is exactly the kind that survives review.

## D-095 — invalidate maps to INVALID only, and has no inverse (P2-11)

`invalidate: true` sets `freshness` to `INVALID`. It does not touch status, `fix_kind`, confidence, or any flag: `INVALID` is a statement about whether the memory still holds, not about where the Problem stands in its lifecycle — that is P2-12's, and D-067's matrix is unaffected.

`invalidate: false` is refused rather than read as "make it current again". A Problem that became `INVALID` may have been `CURRENT` before it, or `STALE_UNKNOWN`, or `SUPERSEDED`, and restoring a guess would overwrite a real distinction. The control route also refuses `freshness` directly, so invalidating and editing freshness in general stay distinguishable; saying a memory holds again means saying which kind of freshness it has, through the ordinary update.

The history records `freshness`, not `invalidate`. The verb is what a caller asked for; the field is what changed, and a reader following the record needs the latter.

## D-096 — Controls are not authorisation, and are not enforced yet (P2-11)

Turning off reads does not hide a Problem from its owner. Every read endpoint keeps answering, and the control route itself stays reachable — otherwise a Problem could be locked away by accident with no way back. A test turns every control off and then reads the Problem, its Events, Verifications, Relations, usage and history, expecting 200 from each.

Nor does any endpoint start refusing writes when `memory_write_enabled` is false. Nothing in this phase can distinguish a person's own write from an assistant's automatic one, so enforcing the flag would mean guessing, and guessing would block the owner from their own record. What these controls govern is automatic retrieval and automatic writing, which belong to the retrieval layer and the AI adapter; recording the intent correctly now is what lets those honour it later.

`changed_by` remains descriptive here as everywhere (D-091): a test writes `root`, `admin` and another owner's id into it and asserts each still reaches nothing.

## D-097 — Closing is its own surface, not metadata on a transition (P2-12)

`CLOSED_UNRESOLVED` and `PAUSED` were already reachable through `POST /v1/problems/:problem_id/status-transitions` (D-067), so a close endpoint had to justify itself rather than duplicate one.

It does, because ending a Problem is usually more than moving its status. A conclusion carries what turned out to be the cause, what worked, what did not, what is still open, and whether the fix addressed the cause or worked around it. Hanging those on the transition route would give one endpoint two jobs and make a plain `INVESTIGATING → FIX_CANDIDATE` move carry fields that mean nothing to it.

`POST /v1/problems/:problem_id/close` therefore takes only the three conclusions — `VERIFIED`, `PAUSED`, `CLOSED_UNRESOLVED`. `INVESTIGATING` and `FIX_CANDIDATE` are working states and are refused with a 400: two surfaces performing the same move differently is worse than one of them saying no. The transition route is unchanged and still performs every move, closing ones included, for a caller that has nothing to record.

## D-098 — Closing applies the same rules, and gets no relaxation for being higher-level (P2-12)

The close service does not re-decide which moves are legal. It calls `decideTransition` with the same inputs and the same evidence check, so the matrix and the `VERIFIED` gate (D-067, D-068) hold identically on both surfaces.

This is the failure worth guarding: a convenient endpoint that quietly accepts what the strict one refuses. So `VERIFIED` still comes only from `FIX_CANDIDATE`, and still only when the Problem has a Verification of its own whose `result` is true — a `final_cause_summary` explaining the cause is an account, not evidence. A terminal Problem cannot be closed again, which keeps closing from becoming a way to revise a conclusion or a `fix_kind` after the fact. Integration tests assert each of those against a real database.

The version is checked before the rule is applied, as in the transition service: a caller working from a stale read has a stale idea of the status too, and answering 409 first is both more accurate and less informative to someone probing.

## D-099 — fix_kind is written by closing, and is a separate axis from status (P2-12)

Nothing set `fix_kind` before this task. It is writable here and nowhere else in this phase: the Problem PATCH, the memory control route and the transition route all still refuse it, because whether a fix addressed the cause or worked around it is a conclusion rather than an edit.

Absent leaves whatever is there; `null` clears it. The distinction is real — closing a Problem while saying nothing about the fix kind is not the same as saying there is no fix kind — so the command carries the property only when the request mentioned it, and the change log names `fix_kind` on the same condition.

Status does not imply it in either direction. A Problem can be `VERIFIED` with no fix kind stated, and a `WORKAROUND` or even a `ROOT_FIX` can be recorded on one that was paused or closed unresolved. Verified says the fix holds; it does not say what the fix was.

## D-100 — A review is Events, not a new resource (P2-12)

The four summaries become ordinary Events: `final_cause_summary` a `DISCOVERY`, `effective_direction` a `FIX`, `dead_end_summary` a `DEAD_END`, `unresolved_points` a `HYPOTHESIS`. No Review table, no Review endpoint, no new event type.

A review is a set of statements about the investigation, which is what an Event already is. Giving them their own home would put the same kind of information in two places with two ways of reading it, and any future retrieval would have to consult both.

`unresolved_points` is a `HYPOTHESIS` rather than a `DISCOVERY` deliberately: an open question is something believed to matter and not yet settled, and filing an unknown as a fact is the mistake this record exists to avoid.

All four are optional. Closing with nothing to add is legitimate — the event history may already say everything worth saying, and a required summary would be answered with filler. Each is non-blank when present, so a whitespace-only account is refused rather than stored.

`changed_by` becomes each Event's `source_ai`: whoever concluded the Problem is who recorded these. It stays descriptive and never authorises (D-091).

No `client_event_id` is asked of the caller, and the close body refuses one. The whole close is already protected by `expected_version` — resending one that succeeded conflicts rather than recording the review twice — so per-summary keys would be four more things for a client to get right for no additional guarantee.

The Events themselves carry one as every Event does. The service mints a distinct id per review Event and stores it on the ordinary column, which is `not null` and unique per owner. Review Events are Events: no exception to the model, no nullable key, no review-specific schema.

## D-101 — The whole conclusion is one act (P2-12)

Status, `fix_kind`, the review Events and the change log entry commit together or not at all, in one transaction and one version step.

A Problem marked verified with the account of why it was verified missing is the worst available outcome, and an account of a conclusion that never happened is barely better. Two tests make failure real rather than assumed: one where the Event write fails and one where the change log write fails, each asserting the Problem is untouched and nothing was left behind. Both were confirmed to fail when the transaction is removed.

Status and `fix_kind` move in a single compare-and-swap, so a conclusion cannot land half-applied. Four concurrency tests race a close against another close, against the ordinary PATCH, against a transition and against a memory control change; in each exactly one wins, the version moves once, one change log entry exists, and the loser's review Events are absent. All four were confirmed to fail when the version predicate is removed.

The summaries stay out of the change log, which names `status` and, conditionally, `fix_kind`. Free text is described rather than copied (D-090), and here it is not even described: the Events are where that text lives, and a second copy in the history would outlive any later removal.

## D-102 — Simultaneous Events have no order, and that is left alone (P2-12)

Two things about Events came out of writing multiple ones in a single transaction, which nothing did before this task.

`appendEvent` recovered from a duplicate `client_event_id` by catching the unique-violation and re-reading the original row (D-059). Inside a transaction that is wrong: the failed statement aborts the enclosing transaction, and the recovery read fails too. It now writes with `on conflict (owner_id, client_event_id) do nothing returning` and reads the original only when nothing was written, so no error is raised on the ordinary retry path. P2-04's idempotency and concurrency tests were re-run against the change, including confirming the concurrency test still discriminates.

The second is unfixed and deliberate. `created_at` defaults to `now()`, the transaction's timestamp, so all four review Events share one, and the Event list breaks that tie on the identifier — a random UUID. They therefore come back in an arbitrary order. Changing the default to `clock_timestamp()` would give insertion order, but it would alter the meaning of `created_at` for every Event in the system to solve a presentation problem: the four statements genuinely were made at the same moment, and each carries its own type, so a reader never needs their order to tell them apart. Recorded here so that a later retrieval layer that does want narrative order knows this is where to start.

## D-103 — The runtime route schemas are the contract (P2-13)

Every route already declares JSON Schema for its parameters, body and each response. Fastify validates requests against those schemas and serialises responses through them, so they are not a description sitting beside the implementation — they are the implementation.

The OpenAPI document is generated from exactly those objects, at startup, by `@fastify/swagger` in dynamic mode. The direction is one-way and there is no second place to edit.

The alternative was a hand-written document, and its failure mode is what settled it: a document can claim `fix_kind` accepts three values while the server accepts two, and nothing anywhere fails. Every schema that appears in the contract is the same object the server enforces, so the two cannot disagree.

This also fixes what P2-13 is for. It is not a place to design a contract; the contract already exists and has since P2-01. This task made it readable by a machine and put a test around it.

## D-104 — Nothing generated is committed (P2-13)

There is no `docs/openapi.json` in the repository, and the endpoint does not serve a file from disk.

A checked-in artefact would have to be regenerated whenever a route schema changed, which makes every schema change two edits, one of which can be forgotten. The first time it is forgotten the repository contains a contract that is wrong and looks authoritative. Generating on startup removes the possibility rather than guarding against it.

What is committed instead is the assertion: a test suite that reads the generated document and pins the inventory and the schemas. That catches a real drift — the route schema changing — rather than a bookkeeping one.

If a build artefact is ever genuinely needed, for a client generator in CI or for publication, it should be produced from the running server rather than maintained.

## D-105 — OpenAPI 3.1, because the schemas already are JSON Schema (P2-13)

The runtime schemas use `type: ['string', 'null']`, enums containing `null`, `enum: [true]` for a flag that accepts only an affirmative, and `minProperties` for a patch that must actually change something.

3.1 adopts JSON Schema wholesale, so all of that survives generation unaltered — confirmed against the generated output, including the `\S` non-blank pattern, which a naive transform could easily mangle.

3.0 would have needed each of those rewritten into its own `nullable` dialect. The obvious way to do that is to change the runtime schemas to suit the document format, which is precisely the inversion this task exists to prevent: what the server accepts would be decided by what a document version can express. So the format moved instead of the validation.

## D-106 — Every route goes through a queued plugin (P2-13)

The generator collects routes through an `onRoute` hook. "Register the plugin before the routes" is therefore necessary but not sufficient, because Fastify defers plugins: `register` queues, and the hook does not exist until the queue runs at `ready()`. A route added directly to the instance in the meantime is registered first in real time and is silently missing from the document.

This is not hypothetical. `/health` was registered straight onto the instance, immediately after the generator was registered, and was absent from a document that otherwise looked complete. The count test is what found it.

`/health`, `/openapi.json` and the `/v1` scope are now all registered through queued plugins, so registration order and execution order are the same thing. The inventory test asserts all 25 operations rather than trusting that ordering stays correct, because the failure produces a plausible document rather than an error.

## D-107 — The contract is public, and outside the owner scope (P2-13)

`GET /openapi.json` sits beside `/health`, not under `/v1`, and requires no owner.

The shape of the API is not anyone's memory: it contains no Problems, no owner identifiers and nothing derived from stored data. Requiring an owner to read it would also be circular — a client cannot learn how to establish one from a document it must already have an owner to fetch.

The route is hidden from its own output. A document that describes the endpoint serving it adds a line no generator needs and invites the question of which version of itself it is describing. It is hidden by being queued behind the generator and marked `hide`, so the exclusion is deliberate rather than an accident of ordering.

It also declares no response schema. An OpenAPI document is an arbitrary object by nature, and serialising it through a schema could only drop parts of it.

## D-108 — operationIds are adapter-facing names, and are part of the contract (P2-13)

Each of the 25 operations has a stable, unique `operationId`: `createProblem`, `appendEvent`, `closeProblem`, and so on. Uniqueness is asserted.

These are not decoration. A generated client turns them into method names, so a duplicate is a collision in someone else's code and a rename is a breaking change to anything built on them. They are named after what the operation does rather than after its path, so that moving a route does not force a rename.

The names are also what makes the document useful to the AI adapter this phase is preparing for: a stable vocabulary it can bind to without parsing paths.

## D-109 — No UI in the Core API phase (P2-13)

No Swagger UI, Scalar, Redoc or any rendered explorer, and no YAML variant.

The Definition of Done is a machine-readable contract, and a JSON document at a known path is one. A UI adds dependencies, static assets, content-security questions and a second thing that has to be served correctly, none of which are needed to consume it. If a rendered view is wanted later it is a task of its own, with those costs stated.

## D-110 — No authentication is described before one exists (P2-13)

The document declares no `securitySchemes`, no global `security`, and no header parameter on any operation.

The current MVP establishes the owner server-side. There is no client-supplied credential, so publishing `BearerAuth` or an API key scheme would describe an authentication method that does not exist — and a generated client would build a header nothing reads, which is worse than saying nothing.

`owner_id` is not represented as a credential anywhere. It appears on resources because it is data. This matches how `changed_by` and `source_ai` already behave (D-091): descriptive, never authorising.

What the document does say, in prose, is that `/v1` is owner-scoped, that owner context is established server-side, and that a client-provided owner id is not authentication. The real credential lifecycle belongs to the later AI-integration phase and nothing here anticipates its shape.

## D-111 — Contract tests assert against the generated document, not the source (P2-13)

The suite reads what generation produced and compares it to literal expected values: the exact operation inventory in both directions, unique operationIds, every enum set spelled out, required fields, `minProperties`, `additionalProperties: false`, the five error codes, and one error envelope shape across every failure response.

Asserting against the constants the routes import would prove the constants equal themselves. The question worth answering is whether the strictness that goes into a route schema still comes out the other end of generation, and whether a schema was loosened by accident — both of which are only visible in the output.

The inventory is exact in both directions, so an added, moved or removed route has to be stated in the test too. A test that discovers the routes it checks agrees with whatever it finds.

The parity test pins that `GET /openapi.json` returns the same document `app.swagger()` reports, and the same one on a second request, so the endpoint cannot become a separately-rendered description.

## D-112 — Sanitization sits where a repository is handed out (P3-01)

The boundary wraps the repository, at `app/request-context.ts`, and nowhere else.

A service does not build a repository — it receives one from the request context, and that is the only way to obtain one. Wrapping at the handout therefore puts the policy on the path of every write there is, without any service knowing it is there, and an adapter written later gets its context by the same route and inherits the same checkpoint. There is no second entrance to remember.

The alternative considered was a `sanitize()` call at the top of each service or route handler. It works until someone adds a write and does not know the convention, and it would not have covered a caller that is not HTTP at all. A boundary that depends on being remembered reports success while a path goes around it, which is the failure this task exists to prevent.

Both handouts are wrapped: the ordinary repository and the transactional one. Wrapping only the first would leave exactly the multi-write paths — close, and every change log — unchecked, which is the opposite of the right priority. An architecture test asserts the count of wrapped constructions equals the count of constructions, and that this file is the only one that constructs.

It is a `Proxy` rather than a hand-written wrapper for the same reason it is not a per-service call. A wrapper enumerating twelve write methods still compiles, still delegates and silently stops covering a thirteenth. Intercepting every call means a new operation is covered because nothing had to be updated for it to be.

Reads are named; anything unnamed is treated as a write. An operation added and never classified is inspected rather than skipped, so the cost of forgetting is a redundant look at an identifier instead of an unchecked write.

## D-113 — Nothing is checked by field name (P3-01)

The traversal descends through objects and arrays to every string it can reach, and reports where each was found. It has no list of fields.

**Corrected by D-116.** As first written this covered values only, which left object keys — equally caller-written, and equally stored — outside the boundary. Keys are now inspected too.

An Environment snapshot is arbitrary JSON the caller composed, and a change log's `changes` has a shape that depends on which fields moved. A boundary checking named fields would be correct for exactly as long as nobody added a field, and would never look inside a snapshot at all — which is the most likely place for a stray `.env` value to arrive.

Identifiers are inspected too. Excluding them would mean this layer deciding which fields matter, and which fields matter is precisely what P3-02 owns. The path — `createEnvironment.0.snapshot.auth.token`, `appendEvent.0.summary` — is passed to the policy so that judgement can be made where it belongs.

The traversal preserves shape exactly: key order, array length, `null` as `null`, and keys whose value is `undefined` still present. That last one is not tidiness. Absent and `null` are different instructions on a partial Problem update — leave this alone, versus clear it — and a traversal that collapsed them would change what a patch does, far from here and for reasons nobody would connect back. It rebuilds rather than mutates, so a service is never surprised by its own input changing and a refusal partway through leaves nothing half-altered.

## D-114 — The boundary ships without a judgement (P3-01)

The policy this phase installs keeps every string. There is no pattern list, no length threshold and no heuristic.

P3-01 is the checkpoint; P3-02 decides what a secret is and P3-03 decides what to do about one. Shipping a provisional detector would have been worse than shipping none: it would look like coverage, its false negatives would be invisible, and the real detector would arrive having to argue against an incumbent nobody designed.

It also makes the installation verifiable. With a policy that changes nothing, every Phase 1 and Phase 2 test passing unaltered is the evidence that a mandatory checkpoint was placed in front of every write without altering any of them.

The interface is deliberately narrow. A policy is shown one string and where it sits — `inspect(text, at)`, where `at` is a `SanitizationSite` carrying a structured path and whether this is a key or a value — and answers keep, replace or reject. It is not given the record, cannot reach the database, and cannot decide whether a write happens. Keeping it that small is what lets the boundary guarantee the policy was consulted for everything it could have needed to see.

*As first written this said "one string and its path" and spoke only of values; keys were added in D-116 and the site structure in D-118. The narrowness argument is unchanged — the interface got more precise, not wider.*

## D-115 — A refusal carries the field, never the value (P3-01)

`SanitizationRejectedError` reports where a refusal happened without reproducing what was refused.

**Corrected by D-116 and D-117.** As first written it held the policy's free-text reason and a path built from raw caller keys, so a policy could put the secret in the reason and a secret in a key became the locator. Both now carry only text the boundary itself produced.

An error travels: into a log line, possibly into a report, through several layers on its way out. Putting the refused value in it would mean the one mechanism built to keep secrets out of storage is also the mechanism that copies them somewhere nobody thinks to check.

What an operator gets is a boundary-generated safe locator and whether a key or a value was refused. Nothing else. This entry originally said "the field and the reason", but the reason was free text a policy supplied and was removed in D-117, and the field was a path built from raw caller keys and was removed in D-118. No caller-supplied and no policy-supplied text reaches an error or a log.

Transport maps it to the existing `INVALID_REQUEST`. The request carried something that may not be stored, which is a bad request rather than a server fault, and adding an error code now would fix an answer P3-03 has not yet decided. With the current policy the path is unreachable, so no client-visible contract changed.

## D-116 — Object keys are content, and a locator is built only from approved ones (P3-01, after review)

The first version of the boundary walked objects with `Object.entries` and showed the policy each value. It never showed it a key.

That was a real way around it. An Environment snapshot is `additionalProperties: true`, so a caller chooses its keys as freely as its values, and `{ "sk-live-...": "ok" }` would have been stored with the secret in the key and the boundary reporting success. Keys are now inspected exactly as values are, and the site says which of the two it is.

The second half of the problem was subtler and is the reason the path type changed. A raw caller key was being used as a path segment, and the path became `SanitizationRejectedError.field`, which transport logged. So a secret in a key would have been refused and then written to the operational log by the mechanism that refused it — the boundary leaking precisely what it existed to stop.

The first attempt at this kept the ordering — a key is inspected before it is appended to the path and before its value is descended into, so a refused key never enters a path at all — and then rendered the *approved* keys, reasoning that the policy had cleared them. **That reasoning was wrong and is superseded by D-118.** The ordering is still there and still worth having; what changed is that no key is rendered outward, approved or not.

Renaming a key is refused outright. Replacing a key is not the same act as replacing a value: the replacement can collide with a key already present and silently merge two fields into one. What should happen then is a genuine design question and belongs with P3-03's redaction rules, so the boundary raises `UnsupportedSanitizationOutcomeError` rather than picking whichever behaviour was easiest to implement.

**Confirmed by D-126.** P3-03 looked at the collision problem and kept key replacement unsupported: a credential in a key is refused, never rewritten.

## D-117 — A policy cannot explain a refusal (P3-01, after review)

`SanitizationOutcome`'s `reject` originally carried `reason: string`, which became `SanitizationRejectedError.reason` and was logged by transport.

The failure mode is obvious once stated: the person writing a detector has the offending value in hand, and the most natural reason to write is the value — "found `sk-live-...` in summary". The boundary would then refuse to store a secret and log it instead. D-115 claimed a refusal never carries the value, but that was a property of the policies written so far, not of the design.

`reject` now carries nothing. TypeScript refuses the version written with an explicit return type, and — the part that does not depend on how someone happened to write their function — the boundary reads `kind` and `value` from an outcome and nothing else, so anything a policy attaches regardless goes nowhere. A test drives a policy that deliberately returns the secret as a reason and asserts it appears in no message, property, serialisation, stack, response or log line.

What an operator gets instead is the locator and whether it was a key or a value. This decision also claimed the policy's *name* was safe to log because it was fixed at construction rather than chosen per value; **that was wrong for the same reason and is superseded by D-119.**

When P3-02 has defined its detection categories, a closed union of codes can be added here deliberately. A fixed set of identifiers is safe in a way that free text is not, and the difference is exactly that nobody can write a value into an enum.

## D-118 — Persistence-safe is not log-safe (P3-01, after second review)

D-116 made the boundary inspect object keys, and then rendered the approved ones into the locator that goes into errors and the operational log. The reasoning was that a key the policy kept is a key the policy cleared. That reasoning was wrong, and the second review found it.

A policy is a *secret detector*. It keeps an email address, a customer name, a file path, an internal hostname — every one of those correctly, because none of them is a secret. What it has decided is that they may be **persisted**, into a record the owner controls, can list, can invalidate and will be able to delete. It has decided nothing about whether they may be **copied into an operational log**, which is a different store with a different lifetime, different access and no delete path yet.

Concretely, `{"customer@example.com": {"api_key": "<secret>"}}` refused at the value would have logged the address of a real customer, from the mechanism whose entire job is to keep sensitive data out of places it should not be.

So there are now two renderings and they are named for what they are. `describeInspectionPath` keeps the raw keys and is documented as not safe to log; it exists because detection genuinely needs the context — `snapshot.auth.token` is what tells P3-02 how to read the value beneath it. `formatSafeLocator` drops every key name and is the only form that reaches an error or a log.

Keys are dropped unconditionally rather than by any rule about which ones look safe. Any rule would be a classifier, classifiers are wrong sometimes, and the failure is silent and permanent. The boundary can distinguish what it chose itself — the operation, the argument position, array indices — from what arrived in a request, and that is the only distinction it makes.

The cost is accepted, not waved away. `createEnvironment[0].<key>.<key>.<redacted>` tells an operator the operation, the depth, the array positions and whether a key or a value was refused, and not which field. Finding the rest means the request id and a local reproduction. That is a worse debugging experience than a field name would be, and there is no version of this that is both maximally helpful and safe.

## D-119 — A policy has no name, because a name is free text too (P3-01, after second review)

D-117 removed the free-text `reason` from a refusal, on the grounds that free text written by someone holding the offending value tends to contain the offending value. It then left `SanitizationPolicy.name` in place and put it into every refusal and every log line, arguing that a name fixed at construction is not per-value and therefore safe.

That distinction does not hold. Fixed-at-construction free text is still free text: it comes from policy configuration, a place where a credential can end up by exactly the same kinds of mistake, and `{ name: process.env.SOMETHING }` is a plausible line of code. The route into the log was the one D-117 had just closed, reopened one field along.

`SanitizationPolicy` now has a single member, `inspect`. There is no name, and nothing else the boundary reads. A test asserts the shipped policy has exactly one key, so adding a field is a decision someone has to make on purpose.

Which policy is configured is a real operational question, and it is a deployment fact rather than a property of any failure. If it needs to be visible it belongs in a line the composition root writes at startup, where it is logged once, by our code, with a value our code chose.

`UnsupportedSanitizationOutcomeError` mattered more than the rejection path here, not less. Nothing catches it, so the generic handler logs the whole error — message and stack — and anything in its message is in the log by definition. Its `detail` is a literal from the boundary's own call sites, and it carries no policy text at all.

The pattern across D-115, D-117 and D-119 is worth stating plainly, because it recurred twice: every time this design left a string that someone outside the boundary could choose, that string found its way into an error and then into a log. The rule that survives is that a refusal is described entirely by values the boundary itself produced.

## D-120 — Detection and action are separate, and stay separate (P3-02)

`detector.ts` decides what a string is. `policy.ts` decides what happens to it. They are different files with different tests and no shared state.

The reason is that P3-03 owns the second question in full — refuse, redact irreversibly, keep a semantic summary — and it should arrive to find a question it can answer rather than an answer already baked into detection. A detector that returned "reject" instead of "this is a JWT" would have made the redaction phase a rewrite.

It also makes each half testable on its own terms. Detection is a pure function over a string and a site, so its suite is a table of fixtures with no server in it. The action is one mapping from finding to outcome, so its suite is six lines and a fake detector. Neither needs the other to be interesting.

The seam is `SecretFinding`, which is data rather than a decision: a category and a certainty. A later phase can key on either, both or neither.

## D-121 — A finding carries no part of what it found (P3-02)

`SecretFinding` is a category and a certainty, both from closed sets. There is no matched text, no excerpt, no prefix, no offset, no regex match object and no hash.

A finding travels — into a policy, potentially into an error, and from there into an operational log. The entire reason for producing one is that the string it describes must not be copied anywhere, so a field holding "the bit that matched" would be the one place the secret is guaranteed to end up, written by the mechanism built to stop exactly that. P3-01 learned this twice, through a free-text `reason` and then through a policy `name`; this is the same lesson applied before it could happen a third time.

No fingerprint or hash either. Those would be worth their risk only if something needed to recognise the same secret twice, and nothing does: there is no deduplication requirement, no rotation tracking and no cross-request correlation in this phase. A hash of a low-entropy secret is also not the one-way door it looks like.

The category is not published outward. It is available to a later phase that may want to act on it, and it is not in the error, not in the response and not in the log — P3-02 has no need to say which rule fired, and every string that has ever escaped this boundary escaped through a field someone added because it seemed useful.

## D-122 — A secret is recognised by meaning, never by shape (P3-02)

There is no entropy score and no length threshold in the detector, and adding one would be a mistake rather than an improvement.

"Long random-looking string" describes a UUID, a git commit SHA, a content hash, a database identifier, a base64 payload and most of the evidence references that make a Memory worth keeping. A detector built on that signal refuses the record's own content, and the response to a tool that cries wolf is to stop sending it things — which leaves the memory emptier than having no detector at all.

So every rule requires a signal that means *credential*: a PEM private-key header, a JWT whose header actually base64-decodes to JSON naming an algorithm, an `Authorization` or `Cookie` header line, a credential-named variable in an assignment, or a credential-named field in the caller's own structure. Names are matched whole against a normalised form, with a short suffix list so `db_password` and `github_token` work without enumerating every prefix anyone might use.

**Extended by D-124.** As first implemented this file also let value shape argue the *other* way: an explicit `PASSWORD=` was believed only if the value carried a digit or punctuation, so `PASSWORD=letmein` was stored. "Meaning, never shape" has to cut both directions — shape cannot convict, and it cannot acquit either.

The cost is stated rather than hidden: a bare credential with no context at all — pasted alone into a summary, with nothing naming it — is not detected. Catching it would mean guessing from shape. The specification's design for this is defence in depth, with adapter-side sanitisation before sending and server-side re-checking after; this is the re-check, and it was never the only check.

`PUBLIC KEY` is deliberately not matched. Publishing a public key is the point of having one.

## D-123 — Confirmed is refused, suspected is kept, and neither is the final policy (P3-02)

Two certainties. `confirmed` is a form that is a credential and is not plausibly anything else. `suspected` is where the evidence is genuinely mixed.

**Corrected by D-124.** As first written, `suspected` meant "the value reads like a word", which made certainty a measure of randomness wearing a semantic label — and made `{"password": "letmein"}` merely suspected, which is to say stored. Certainty now measures how strongly the *context* names a credential: a strong name is `confirmed` whatever the value looks like, and value shape only separates the two under an ambiguous name.

P3-02 refuses `confirmed` and keeps `suspected`.

The refusal is not the reject policy. P3-03 owns that, and this is fail-closed holding P3-02's own completion condition — a representative secret must not be stored in plaintext — by the least-invented means available. Nothing is redacted, replaced or summarised, because a half-designed redaction is harder to undo than a refusal and would prejudge the phase that is supposed to decide it.

**Settled by D-126.** P3-03 replaced the blanket refusal with redaction where a credential can be removed safely, and kept refusal where it cannot. `suspected` is still kept, exactly as decided here.

Keeping `suspected` is the deliberate half. Widening refusal to cover it would refuse configuration templates, documentation examples and the ordinary act of writing down that a credential was involved, and a caller who cannot record what happened is the failure this whole record exists to prevent. Nothing about a suspected finding is logged either: "we saw something that might be a secret at this path" only helps someone who already has the data, and it puts a claim about caller content into an operational log for nobody's benefit.

The false-positive fixtures are treated as requirements rather than courtesy checks, and the detector was made the default policy so that every pre-existing test — roughly nineteen hundred of them, full of UUIDs, commit SHAs, snapshots and evidence references — runs as a false-positive corpus on every build.

## D-124 — Shape can neither convict nor acquit, and a header must be parsed (P3-02, after review)

Two findings from the second review of P3-02, with the same root: value shape was doing work that only meaning should do, and a pattern match was standing in for parsing.

**Explicit context outranks value shape.** `looksLikeCredentialValue` required a digit, punctuation, mixed case or twenty characters, and it gated *everything* — including an explicit `PASSWORD=`. So `PASSWORD=letmein`, `API_KEY=abcdef`, `client_secret=supersecret` and `{"password":"letmein"}` were all stored in plaintext, and `PASSWORD="correct horse battery staple"` was too, because a passphrase contains spaces. The weakest real credentials were precisely the ones that got through, which is the worst possible bias for a detector to have.

D-122 said meaning, never shape. It was applied in one direction only: shape was correctly refused as *evidence for* a secret, and then quietly accepted as *evidence against* one. People choose credentials that read like words, and that a password looks like a word is a fact about people rather than information about the string.

Names now carry a strength. `strong` names — `password`, `api_key`, `client_secret`, `access_token`, `private_key` and the rest — have no ordinary reading, and under one the value's shape is not consulted at all. `ambiguous` names — `token`, `secret`, `session`, and compounds ending in them — do have an ordinary reading, and there value shape is what separates `confirmed` from `suspected`. That is the only place shape decides anything, which is what D-123's certainty was supposed to mean all along.

The false-positive side is handled by reading the *content* rather than measuring it, in one place used by every rule: a value is a `placeholder` (already redacted, or a template), a `status` word (`unknown`, `expired`, `rotated` — a note about a credential rather than one), or a `value`. Only the third is a credential. The status list is deliberately small and closed, and anything not on it counts as a value, because being wrong there costs a refused note and being wrong the other way stores a password.

**A header is parsed, not matched.** `authorization\s*:\s*\S+` confirmed `Authorization: disabled`, `Authorization: Bearer` with nothing after it, and `Authorization: Bearer [REDACTED]`. The bare form confirmed "Use Basic authentication for this endpoint." — `authentication` is fourteen characters of the right alphabet. A detector that refuses those teaches people to stop sending it things, which empties the record more effectively than having no detector.

`Authorization` now requires a recognised scheme *and* a credential after it, and the credential goes through the same content reading, so a placeholder inside a header is treated exactly as a placeholder anywhere else. The bare `Bearer x` form has no explicit header to trust, so it additionally requires the token to read like a credential rather than like the next word of a sentence — with trailing sentence punctuation stripped first, since the full stop in "expects Bearer tokens." belongs to the sentence. Cookies are parsed into pairs and confirmed only when a pair holds an actual value.

One line is judged once: a line beginning `Authorization:`, `Cookie:` or `Set-Cookie:` belongs to those parsers, and the generic assignment rule skips it. Without that, the assignment rule read `Authorization: Bearer [REDACTED]` as the field `Authorization` holding the value `Bearer` and confirmed it anyway — the same bug one rule further down. `authorization=rawtoken`, with `=` rather than `:`, is a variable assignment and is judged as one.

Nothing about the leak guarantees changed, and the new weak-credential fixtures are covered by the same database, response and log sweeps as the rest.

## D-125 — Detection and redaction read the same rules, and spans stay inside (P3-03)

`patterns.ts` holds every rule about what a credential looks like and where it sits. The detector asks it what a string *is*; the redactor asks it *where*. Neither owns a copy.

Two copies would drift the first time either was edited alone, and the failure would be silent in both directions. A detector recognising a form the redactor could not locate would refuse writes that were perfectly removable. A redactor locating a form the detector did not recognise would rewrite text nobody asked it to. Both are the kind of bug that shows up as "the tool is unreliable" rather than as a test failure.

What the shared module reports is spans — offsets into the string. The detector discards them and keeps only a category and a certainty; the redactor keeps them just long enough to build the replacement.

Those offsets never leave the directory, and an architecture test pins that: the words `Span`, `findJwtSpans`, `findAssignmentValues` and `replaceSpans` appear in exactly three files. An offset and a length are information about a secret — how long it is, where in the text it appeared — and `SecretFinding` was deliberately built as two closed identifiers so that nothing of that shape could travel into an error or a log (D-121). Adding spans to a finding would have undone that quietly.

## D-126 — Redact a value where it is safe, refuse where it is not (P3-03)

The action for a confirmed credential depends on whether it can be removed, not on what kind it is. There is no category-to-action table, because no requirement has asked for one and inventing one would fix answers nobody has needed yet.

**Redacted, in a value.** Prose keeps its sentence — `API_KEY=abc123` inside "the deploy failed because … was stale" loses four characters and keeps the finding. Refusing that write would have lost the investigation, which is the failure this whole record exists to prevent. The variable name survives deliberately: `API_KEY` is the part a future reader needs. Every credential in the string goes, not the first, because a `.env` paste holds several and removing one reads as though the string had been cleaned.

**Whole-value, under a credential-named field.** `{"api_key":"secret"}` has nothing around the credential to preserve — the value *is* the credential, however it happens to be written.

**Refused, when the extent is unknowable.** An unterminated PEM block starts and never finishes. Its end is not discoverable, so there is no span that safely covers it, and guessing would leave part of the key material stored. `null` from the redactor is a refusal, never a shrug.

**Refused, in an object key.** Key replacement stays unsupported, as P3-01 left it (D-116). `{"sk-live-A":1,"sk-live-B":2}` redacted to one name each would collapse into a single field and lose data with nobody told. Suffixing to avoid the collision leaks the original key count. Refusing hands the problem back to the caller, who can fix it — the credential was in a field *name*, which is an unusual enough mistake that the cost of refusing is low.

**Kept, when suspected.** Unchanged from D-123. Rewriting a documentation example would be worse than storing it.

`[REDACTED]` is the marker because the placeholder vocabulary already recognises it. That is what makes redaction idempotent: redacted text run through again is read as already handled rather than as a fresh credential, so records survive an export, a migration or a retry without being rewritten each time.

## D-127 — The redacted text is checked again, and a survivor refuses the write (P3-03)

After redaction the result goes back to the detector, and if a confirmed credential is still there the write is refused rather than stored.

Partial removal is the worst outcome available here, worse than either doing nothing or refusing. A record that has been through redaction reads as sanitised: the marker is visible, the caller got a success, and nobody looks again. A credential that survived that is hidden more effectively than one that was never touched.

The check costs one extra detector call on a path that is already rare, and it converts an entire class of future bug — a pattern the redactor bounds slightly wrong, a form it handles incompletely — from a silent leak into a visible refusal. Everything in the policy fails toward refusing for the same reason: `null` from the redactor refuses, a key refuses, and a survivor refuses.

## D-128 — Validation errors are logged without anything a caller wrote (P3-03)

Ajv reports an `additionalProperties` failure by naming the offending property. Fastify attaches that array to the error, and the handler logged the error object — so a request with an unknown top-level body key wrote that key into the operational log.

This was real and measured: a body key of `sk-live-…` appeared at `err.validation.0.params.additionalProperty`. It also happens *before* sanitization, since validation runs first, so none of the boundary's guarantees applied to it. A caller who put a credential in a field name would have had it refused and then recorded — which is the exact shape of the leaks P3-01 review found twice, arriving through a third door.

Nothing from a validation error is logged now. What replaces it is `validationContext` — `body`, `params`, `querystring` or `headers`, chosen by Fastify from the schema — and a count. Both are server-generated. An operator gets which part of the request failed and how badly, and finds the rest from the request id.

The malformed-JSON branch was given the same treatment. Node's own `JSON.parse` message quotes the bytes it choked on, so the message is unsafe in principle; Fastify 5 replaces it with a fixed `FST_ERR_CTP_INVALID_JSON_BODY` string and no leak was observed. That change is hardening against a future Fastify or a custom parser rather than a fix for something seen, and its test cannot currently fail — which is worth knowing when reading it.

This is not P3-10. The general logging policy is untouched; these were two specific paths that defeated P3-03's own completion condition.

## D-129 — Certainty is the strongest evidence, not the first parser to answer (P3-03, after review)

`{"api_key": "token=morning"}` was stored in plaintext. The value contains a suspected-looking inline assignment — `token` is an ambiguous name, `morning` an ordinary word — and the detector returned that suspicion immediately, before consulting the structure. The structure says `api_key`, which is a strong name, which is confirmed. The write was kept on the weaker of two verdicts, and D-124's guarantee that value shape never acquits under a strong name had regressed one level up: not inside a rule this time, but in the ordering between rules.

The fix is the principle stated as code: a suspected verdict may only leave the detector after every source of a confirmed one — content rules, confirmed assignments, and the structured field context — has been asked. Where both the assignment and the structure confirm, the more specific category wins; what can never happen is a downgrade because a weaker parser ran earlier.

One consequence is worth naming because it looks like a change and is not. `{"session": "token=expired"}` is now confirmed and redacted: `session` is ambiguous, and a value containing `=` reads as credential-shaped, which is exactly the D-124 matrix — `{"session": "abc123def"}` was already confirmed on the same rule. The shadowing bug had been hiding that cell of the matrix, not softening it.

The mutation proof for this one is the reason the lowercase markers from the fixture review exist: with the old ordering restored, the database sweep itself fails, showing the marker stored in plaintext rather than a unit expectation merely disagreeing.

## D-130 — A credential belongs to a client, and the owner is reached by joining (P3-04)

The credential table does not carry `owner_id`. It would be one column and it would make every query shorter, and that is precisely the argument to refuse it.

Two copies of the same fact can disagree. A credential row whose `owner_id` says one thing and whose client says another is not a hypothetical once anything moves a client, backfills a column, or restores one table from a backup taken at a different moment — and the disagreement is silent, because both answers look authoritative. Whichever one the authentication path happens to read decides whose memory a request reaches.

So there is one path to an owner: credential → client → owner, by join, every time. It is a little slower and it cannot be inconsistent with itself. The lookup runs once per request against a unique-indexed column, which is not where this system will be slow.

The same reasoning is why revoking scopes by owner in the statement rather than by comparing an owner id the caller supplied: the check and the write are one operation, and there is no window between them.

## D-131 — The server stores a digest and cannot reconstruct a token (P3-04)

A token is `mem_<lookup>_<secret>`. The lookup is a public selector; the secret is 32 random bytes rendered base64url, and only its SHA-256 digest is stored.

The split exists so the lookup can be indexed and searched while the secret never has to be. A scheme with one opaque value has to either index the secret itself or scan, and indexing a secret puts it in the clear in a second structure that nobody thinks about.

The comparison is constant time. Both sides are 32 bytes by construction — the column is checked to be — so the lengths always agree and the timing says nothing about how much matched.

That the digest is one-way is the property the whole scheme rests on, and it has a consequence worth stating plainly rather than treating as a limitation: a lost token is replaced, never recovered. There is no support path that reads a credential back out, because there is nothing to read.

A mutation proved this needed a better test than it had. Replacing the digest with the secret's own bytes passed all fifty-two credential tests, because `to_jsonb` renders `bytea` as hex and no substring search for a base64url secret finds it. The test now decodes the column and compares against a digest computed from the standard library rather than by calling the function under test — the latter asserts only that hashing is self-consistent, which a reversible "digest" satisfies too.

## D-132 — Knowing an owner's identifier is not holding a credential for it (P3-04)

`MEMORY_OWNER_ID` established the HTTP request context from Phase 1 until this task. It no longer can, and no fallback was left for the case where no `Authorization` header is present.

An owner id lives in `.env` files, in shell history, in process listings, in whatever a developer pasted into a chat. Accepting it as proof of identity would make all of those a password — one that cannot be rotated, cannot be revoked, and is printed in every response that carries `owner_id` because it is data.

The tempting version of this change keeps the fallback for local development. That is the same bypass with a nicer name: it is production code, it is on the request path, and the condition guarding it is "the caller sent no credential", which is exactly what an unauthenticated request looks like.

Thirty-eight test sites depended on the old path. They moved to an explicit double in `tests/support/`, documented as having no production equivalent. Keeping a production fallback to spare that work would have been trading the guarantee for the cost of a migration that took one pass.

`MEMORY_OWNER_ID` remains what it always was for local tooling: bootstrap, and issuing and revoking credentials. It has no route into a request.

## D-133 — Every request is verified against the database, and nothing is cached (P3-04)

No process cache, no per-connection cache, no map keyed by lookup. The credential is read on every request.

The cost is one indexed lookup. What it buys is that revocation means revocation: the next request fails, in the same process, with no restart and no expiry to wait out. A cache — even a short one — makes "revoked" mean "revoked within N seconds", and N is chosen by whoever tuned the cache rather than by the person whose credential leaked.

This is also why revocation is a timestamp on the row rather than a deletion. A deleted credential and a credential that never existed are indistinguishable afterwards, and the question "was this revoked, and when" is one an operator will eventually need to answer. The authenticator checks it explicitly; removing that check leaves a revoked credential working, which is one of the mutations.

## D-134 — The credential store is not Memory, and is not sanitized (P3-04)

`CredentialRepository` is separate from `MemoryRepository`, is not owner-scoped, and does not pass through the sanitization boundary. Each of those is structural rather than stylistic.

It cannot be owner-scoped: looking a credential up is what *decides* the owner, so there is no owner-scoped anything to run it through yet.

And it must not be sanitized. The boundary exists to keep credentials out of what a person writes down. Pointing it at the credential store inverts that — it would inspect a SHA-256 digest for signs of a credential, which is wasted work at best, and at worst a policy deciding to redact the one column that has to survive verbatim. A sanitization policy that can refuse a write to the credential table is a policy that can lock an owner out of their own memory.

An architecture test pins the separation: nothing in `src/repository/` may import credential code or name a credential, nothing in `src/credentials/` may reach the Memory repository or the HTTP layer, and `withSanitization` appears in exactly two files.

## D-135 — The document declares the authentication it has, no more and no less (P3-04)

P2-13 published no security scheme because none existed, and inventing `BearerAuth` would have produced generated clients sending a header nothing reads (D-110). P3-04 makes one exist, and the same rule now requires the opposite action: the document declares `memoryToken`, the one scheme the server implements.

It is a document default rather than a per-route declaration, so a route added without a thought about authentication is documented as requiring it — the failure mode of per-route security is a new endpoint silently documented as public. `/health` is the only exemption, because a probe that needed a credential could not answer during the failure it exists to report. `/openapi.json` is unauthenticated and hidden from its own output: a client that cannot read the document cannot learn how to obtain a credential.

The contract version moved 0.1.0 → 0.2.0. It describes the `/v1` surface, and requiring a credential is a change to that surface.

Credential management is deliberately not in the document, because it is deliberately not in the API. Issuing and revoking are local commands. An endpoint that mints credentials has to decide what may call it, and that decision belongs to whoever administers the machine rather than to a request — the bootstrap problem does not get easier by being moved over HTTP.

## D-136 — The unit of physical deletion is a Problem and everything referring to it (P3-05)

The spec allows complete deletion for three cases — something a person explicitly wants gone, something that was never worth keeping, and a credential written into a record by mistake — and names the unit `delete_memory`. A Memory is a Problem, so the operation removes one Problem, its events, verifications and change log, and every relation and usage log naming it.

What it deliberately is not is a search for a string. "Remove this secret from wherever it appears" would be a different operation with a different shape: it would have to accept the secret as a parameter, which means a request carrying a credential, validated and logged on its way in, in order to remove a credential. The sanitization boundary stops new ones arriving; this removes the record that already holds one. Those two together are the answer, and a third mechanism that hunts for values is not.

Project and Environment deletion is out of scope for the reason it was out of scope in Phase 2: the breakdown says explicitly that dangerous operations outside MVP requirements may go unimplemented, and nothing in the delete cases requires removing a container to remove what it contains.

## D-137 — Physical means physical: no tombstone, no flag, no record it existed (P3-05)

The row is deleted. There is no `deleted_at`, no `DELETED` status, no tombstone entry and no separate table recording that a Problem was removed.

The soft-delete version of this is tempting and worse. Every read, list and append in the system would have to remember to exclude the deleted row, and the one that forgot would serve exactly the content the delete existed to remove — a failure that looks like ordinary retrieval and would be found by whoever the deletion was protecting. With the row gone there is nothing to exclude: every path already resolves the Problem first, so all of them answer 404 without a line of new code, and it is the same 404 as for a Problem that never existed and one belonging to somebody else.

Nor is a "Problem X was deleted" record kept. It could not live in the change log — that is attached to a Problem, so keeping the entry means keeping the Problem — and a new table for it would be a durable statement that a particular Problem existed. For the person deleting a mis-saved credential, that statement is part of what they asked to be rid of. The operational log records that a delete happened, by the closed identifiers this codebase chose; that is a different question from P3-10's audit policy and does not decide it.

The request carries no `changed_by` for the same reason: the history it would be written into is being deleted, so it would be free text collected solely to be logged, which is the egress P3-01 through P3-03 spent three tasks closing.

## D-138 — A reference from another Problem goes with the deletion (P3-05)

`relations` and `usage_logs` each have two foreign keys into `problems`, and the second of each pair points *in* from somewhere else: a relation another Problem recorded against this one, and a usage log saying another investigation drew on this one as memory. Both are removed.

They carry free text — a relation's reason, a usage log's reason and result — written while looking at the Problem being deleted. Leaving them would leave sentences about it, possibly quoting it, in the database after a request that asked for it to be gone.

The consequence is real and is accepted rather than hidden: a Problem that had nothing to do with the deletion can lose part of its own history, and nothing tells it why. The alternative was to null the references, which would need `to_id` and `memory_id` made nullable — weakening a NOT NULL composite foreign key in order to keep a row whose subject no longer exists, and its text along with it. The user's request to remove something outranks another record's account of it.

## D-139 — One transaction, and RESTRICT is the guard rather than an obstacle (P3-05)

Six statements across six tables run in one transaction opened by the service. The states in between — events gone but the Problem still there, relations removed from one side only — are each a Problem that has quietly lost part of its history with nothing recording that it happened, which is worse than the delete failing outright.

Every foreign key stays `ON DELETE RESTRICT` (D-034). No cascade was added, and this is where that policy earns itself back: the delete path's list of tables is the single description of what a deletion reaches, and if a later table gains a reference to `problems` and is not added, the final statement fails on the foreign key and the whole transaction rolls back. The table keeps its rows, the Problem keeps existing, and the omission is loud. Cascade would have made the same omission silent and irreversible.

That failure is deliberately not translated into a version conflict. It is a programming mistake — a table missing from this file — and reporting it as "your version was stale" would hide the bug behind a plausible retry. Only a version mismatch is a 409.

The lock taken on the Problem row is worth stating precisely, because it does less than it appears to. Correctness comes from the version predicate on the last statement: the Problem is removed only if it is still at the version named, so a writer landing in between is refused rather than overwritten, with or without a lock. What the lock adds is determinism — a concurrent writer waits instead of causing five statements' work to be rolled back. A concurrent append is blocked either way, because deleting the Problem locks its row a moment later, which is why removing the lock fails no behavioural test and is pinned by an architecture test instead.

## D-140 — `expected_version` guards the Problem, not its children (P3-05)

A delete requires the version the caller last saw, and it catches a change to the Problem itself: an edit, a status transition, a conclusion.

It does not catch an event or verification appended in the meantime, because appending does not move the Problem's version. Phase 2 made appends independent of the Problem's optimistic locking deliberately — they are append-only writes with their own idempotency key — and changing that here would rework locking and idempotency for every write in the system in order to add a guard to one.

So the honest statement of the guarantee is this: a delete decided at version 5 can remove an event that arrived after the decision was made. Requiring the version and describing it as protecting the whole aggregate would claim a guarantee the code does not provide, which is worse than the gap.

No confirmation flag is accepted either. Any client able to send the delete can send `confirm: true`, so the field would record that the client knew about the field. The spec's "explicit user intent" is a responsibility of whatever calls this on a person's behalf — an adapter, a UI — and the Phase 8 interface will carry it. Pretending to enforce it at the server would make a real requirement look satisfied.

## D-141 — A future retrieval artifact joins the delete path, or the delete fails (P3-05)

The completion condition mentions search derivatives and caches. None exist: eleven tables, no views, no materialized views, nothing derived. So P3-05 removes nothing of the kind, and no empty table, fake cache or `DeletableArtifactStore` was created to have something to point at — an abstraction with no implementation is a shape that will be wrong when the first real one arrives.

What was added instead is a test pinning the exact set of foreign keys pointing into `problems` — seven of them, since `relations` and `usage_logs` contribute two each. A new reference fails that test, and whoever adds it has to decide whether the delete path takes it too. Combined with RESTRICT, forgetting is not silent in either direction: the test fails first, and if it somehow does not, the delete does.

The rule for later phases, recorded here and in the task list: **a phase that adds a retrieval artifact, a search index or any cache derived from Memory must extend the physical delete path and the Phase 3 delete end-to-end in the same change.** Anything living outside PostgreSQL — a vector store, an external search index — cannot be reached by a foreign key, so its delete integration has to be written deliberately when it is introduced.

## D-142 — Export is the format, not a migration tool (P3-06)

The task is a JSON export of one owner's Memory and a demonstration that the format can be read back into a clean environment. It is not an importer, and that is the specification's own line rather than a scoping convenience: §25.9 says import exists as an optional Phase 1 feature and is *excluded from the Core MVP completion condition*, and the Phase 3 Definition of Done says only that an owner's Memory can be exported.

So there is no import endpoint, no bulk import command, no restore tool. The re-importability claim is proved instead — an artifact is handed back to PostgreSQL, unpacked with SQL, and the restored owner is exported again and compared. That proof deliberately uses raw SQL rather than a TypeScript helper. A helper written to make a test pass becomes the de-facto specification for the real importer, and it would be a specification nobody reviewed.

The unit is the owner's whole Memory, matching the spec's `export owner Memory` and the `export_memory` operation, which takes no argument. Per-project and per-problem exports were not built: a project-scoped export would cut cross-project relations in half, and deciding what to do about that is a design question no requirement has asked yet.

## D-143 — The export format has its own version (P3-06)

`schema_version` is `"1"`, a constant of its own, and deliberately not the API contract version.

The two move for different reasons, and the evidence is one task old: P3-05 added a route and took the contract from 0.2.0 to 0.3.0 while changing nothing about what an export contains. Had they shared a constant, everybody holding an artifact would have been told its format had changed, and the only safe response to that is to re-read the whole file.

A plain counter rather than semver. Semver promises three axes of compatibility; a reader of an artifact has one question — can I read this — and answering it with three numbers invites the other two to be interpreted. A string rather than a number so a future `"2-draft"` needs no type change.

## D-144 — The owner appears once, and a restore chooses its own (P3-06)

Every record in the export omits `owner_id`. The envelope carries `source_owner_id`, once.

The repetition argument is the small half: the same UUID on every row of a large file says nothing new. The real one is that it would read as though ownership were a property of each record, and it is not — it is a property of the export.

`source_owner_id` says which Memory the artifact came from. It is not a credential, and it is not an instruction to a restore. An owner id is issued by this server and means nothing anywhere else; since P3-04 a request's owner comes from the credential presented, so a restore into another install gives the records to whoever that install issued a credential for. Requiring the UUID to match would make Memory portability depend on owner identity, which are different things.

Nothing is lost by the omission. Restoring to the original owner just means writing `source_owner_id` into the column, which is what the proof does with a different owner.

## D-145 — Every other identifier is preserved exactly (P3-06)

Project, environment, problem, event, verification, relation, usage log and change log identifiers all survive, as does `client_event_id`.

Remapping would mean rebuilding the whole reference graph: relations name two Problems, usage logs name two, change logs name one, and a restore would have to hold a translation table and rewrite each. That is importer work, and this task is not building an importer — a format that *needs* one to be interpreted is not portable, it is a private encoding.

Preserving `client_event_id` matters separately. It is the idempotency key, so a restored Memory still refuses a resent Event instead of duplicating it; an export that dropped it would silently remove that property from every restored record.

One consequence is worth naming because it looks like a bug: restoring an artifact into a database that still holds the rows it came from fails on the primary key. That is the right answer. A restore that made second copies under fresh identifiers would turn one Memory into two that drift apart, with nothing to say which was real.

## D-146 — The document is built by one statement and never parsed on the way out (P3-06)

The whole export is one SQL statement returning text, rather than eight queries and an object literal. Two properties come from that, and neither could be had cheaply otherwise.

**Consistency.** An artifact has to describe one moment: every Problem it names with its events, every relation pointing at a Problem also in the file. Eight statements under the default isolation level take eight snapshots, so a delete landing between the third and fourth produces a document describing a state that never existed. A single statement sees one snapshot by definition — no transaction, no isolation level anybody has to remember to set, and no lock, so an export blocks no writer.

**Precision.** Two kinds of value cannot survive JavaScript, and both are ordinary here:

- `timestamptz` keeps microseconds; a JS `Date` keeps milliseconds. A real stored `created_at` measured during this work ended `.015452`, and anything passing through the driver's `Date` would have written `.015`.
- `jsonb` keeps numbers as `numeric`. `JSON.parse` turns 12345678901234567890 into 12345678901234567000, and an environment snapshot is whatever the conditions were — a build number, a nanosecond clock.

So PostgreSQL formats the timestamps to six digits, embeds the snapshots as JSON, and hands over the finished document as `text`. The route sends those bytes with the schema-compiled serialiser overridden, because `JSON.parse` followed by `JSON.stringify` is not a round trip for this document. The response schema still describes the shape for the contract; it no longer decides the bytes.

That also keeps the largest body in the system away from `fast-json-stringify`, which reports a type mismatch by quoting the offending value — an error that would reach the unhandled branch and put Memory content in an operational log. The general question of what serialisation errors may say belongs to P3-10 and is untouched.

One asymmetry follows and is not a defect: a request body is parsed before the server sees it, so a number too large for JavaScript cannot be *stored* through the API at all. The export is lossless with respect to what the database holds.

## D-147 — A Memory holding a credential is not exported, and not redacted either (P3-06)

Three options existed and two were rejected.

Redacting on the way out breaks what the export is for. The completion condition is that the format can be restored into a clean environment; an artifact that silently differs from the database is not a copy of it, and restoring one would replace real content with markers.

Exporting it anyway ignores what an export is. Every other operation answers one request about one record; this hands over everything, into a file that goes into a backup, a cloud drive, an email.

So a confirmed credential refuses the export with `EXPORT_BLOCKED`. The owner can act on that: the delete path exists, and it was built one task earlier. Only *confirmed* blocks — the same certainty line P3-02 drew — because withholding somebody's own Memory on a suspicion is a worse failure than the suspicion occasionally being right.

`EXPORT_BLOCKED` is its own code rather than a borrowed one. It shares 409 with a version conflict because both mean the request met a state it cannot proceed against, but a client reading `VERSION_CONFLICT` would go looking for a version to re-read, and `INVALID_REQUEST` would send it to inspect a request that was correct. The response carries nothing about what was found: naming the record would put a map to the credential in a message that travels wherever the response does.

The policy lives in `src/sanitization/`, beside the write policy, not in the export service. What a credential looks like is that directory's to know — an architecture test pins that nothing outside it names the detector — and a service able to ask the detector directly could also decide to disagree with it.

## D-148 — Exporting does not change the Memory (P3-06)

Reading your own data must not edit it. Finding a credential during an export does not redact it in place, invalidate the Problem, suppress it, or delete it; the refusal leaves the database byte-identical, and a test asserts that against `to_jsonb` before and after.

An architecture test pins that the export module contains no `insert`, `update` or `delete` at all. The temptation this guards against is specific: the moment the export discovers a credential is exactly the moment fixing it in place looks helpful, and a read operation that quietly rewrites the caller's memory is a worse surprise than the refusal.

Export is likewise not a precondition for deleting (D-034 settled that) and deleting does not export first.

## D-149 — Credentials are not part of a Memory, so they are not in its export (P3-06)

`clients` and `client_credentials` are absent from the artifact — no token, no lookup, no digest, no client id, no label, no revocation state — and the export module does not read those tables at all.

A credential is how an owner reaches their Memory, not part of it. An artifact carrying one would move access along with the data: a backup file that is also a key, sitting wherever backups sit. Since P3-04 the two are separate boundaries with separate repositories, and this is the first operation that could have quietly rejoined them.

Two architecture tests hold it: the statement that actually runs reads exactly the eight Memory tables, and neither the export module nor the export service may import credential code. The first inspects the generated SQL rather than the source that builds it, because the table names are interpolated and reading the file would check the generator's shape instead of what it produced.

## D-150 — A credential is named after who issued it, so strong compounds work as suffixes (P3-06, after review)

`AWS_SECRET_ACCESS_KEY=…` was not recognised as a credential. Not weakly recognised — invisible, in all three shapes: as an assignment in prose, as a bare assignment, and as a value under its own name in an environment snapshot. It was reproduced before anything was changed, with a real credential, a real database and real HTTP: `GET /v1/export` answered 200 and the secret was in the body.

The cause is a shape in the vocabulary rather than a missing word. `accesskey`, `secretkey` and `securitytoken` were all present, as *exact* names. `normaliseName('AWS_SECRET_ACCESS_KEY')` is `awssecretaccesskey`, which equals none of them and ends with no strong suffix, so it fell through to `none` — the same answer an ordinary sentence gets.

That is the general bug and the reason the fix is not one word. Real credential variables are almost never bare: they carry the issuer in front. A vocabulary of exact names recognises the term and misses every use of it, and this would have recurred for the next provider.

So three compounds became suffixes, chosen one at a time against the test the strong names already state — no ordinary reading:

- `secretaccesskey`, which is what actually catches the AWS variable. "Secret access key" names a credential and nothing else.
- `secretkey`, so `MY_SECRET_KEY` and `HMAC_SECRET_KEY` are covered too. Bare `secret` stays ambiguous, because a field called `secret` may hold a boolean; the compound does not have that reading.
- `securitytoken`, so `AWS_SECURITY_TOKEN` stops being merely ambiguous. Bare `token` stays ambiguous, as before.

Three were deliberately left as exact names, and this is where the correction could have done harm:

**`accesskey`** is the obvious one-line fix and is wrong. "Access key" has an ordinary reading: HTML gives every element an `accessKey`, and menus and shortcuts use the word the same way, so as a suffix it would make `menuAccessKey` a credential. Nothing is lost by leaving it out — the secret half of an AWS pair is `SECRET_ACCESS_KEY`, and the `ACCESS_KEY_ID` half is a public identifier that AWS prints in its own examples. Treating that as a credential would refuse an ordinary note about which account something ran under.

**`pwd`** is left exact because `OLDPWD` is a directory.

**`passwd`** is left exact because names ending in it tend to be paths.

Regression tests hold both directions: the AWS forms are confirmed, and `menuAccessKey`, `buttonAccessKey`, `element_access_key`, `OLDPWD` and a bare `secret` holding `true` are not. Adding `accesskey` as a suffix fails two of them, which is the point of writing them down.

Nothing else moved. `SecretFinding` is unchanged, no category was added, no value or offset appears in a finding, and the placeholder and status rules are untouched — `AWS_SECRET_ACCESS_KEY=REDACTED` and `=rotated` still read as somebody describing a credential rather than holding one.

One limit is worth recording rather than leaving to be rediscovered: `AWS SECRET ACCESS KEY = …`, written with spaces, is still not an assignment. The parser takes an identifier, because a rule that accepted spaces around `=` would read "the access key = whatever we agreed" out of ordinary prose. The structured-field rule covers the same credential when it sits under a name.

The mutation proof is what makes this more than a unit test. Removing the correction fails 21 tests, and five of them are the real export: `GET /v1/export` returns 200 with the raw secret in the body. Removing only `secretaccesskey` still fails those five. The detection gap and the egress it opened are pinned separately.

## D-151 — The retry queue is not part of the Memory Server (P3-07)

The spec asks that a Memory failure not stop the work an assistant is doing, that an important Event go to a temporary queue, and that it be resent on recovery. E2E-7 names the failure exactly: *Memory Server が落ちても* — even when the server is down.

A queue inside the server cannot satisfy that. When the process is stopped, or the network is unreachable, or a connection is refused, the request never arrives; there is nothing for a server-side queue to hold. Such a queue rescues one case out of ten — a database that is briefly gone while the HTTP server still answers — and calling that "Memory Server failure handling" would be claiming a guarantee that fails in exactly the situation it names.

So the queue is a client-side library. `src/reliability/` is imported by nothing the server runs: not `src/http`, not `src/app`, not `src/db`, not the entry point. An architecture test fails if that changes, and it is not a style rule — something the server starts cannot be the thing that keeps working when the server stops.

It lives in this repository anyway, and that is a deliberate compromise rather than an oversight. The adapters that will use it are Phase 5 and Phase 6, so shipping it with them would mean writing it twice; and what it encodes — which writes the server deduplicates, what it says when it refuses one, what a credential may never be written into — is this project's knowledge. Keeping it here means those answers exist once, with tests, rather than being reconstructed by two adapters that will not agree.

The task list places retry queue in Step 3, before any adapter exists. That tension is real and is recorded rather than resolved by reinterpretation: the component is built now, and the scheduler and transport that drive it belong to whoever ships an adapter.

## D-152 — Only the two writes the server deduplicates may be queued (P3-07)

`appendEvent` and `appendVerification`, and nothing else.

Both carry a `client_event_id`, and the database has a unique index on `(owner_id, client_event_id)` with the first write winning (D-058, D-063). Sending one of them twice therefore leaves one row, which is what makes a retry safe at all. Nothing else in the API has that property. Creating a Problem twice makes two Problems. A Problem update, a status transition and a close all carry `expected_version`, which is a statement about a moment that a retry has already left behind. Relations and usage logs have no idempotency key, deliberately.

Deleting is not on the list and must never be added to it. A retried delete is a destructive operation replayed against a state nobody checked, and the queue exists to protect work rather than to repeat the removal of it.

The operation is a closed union of two, pinned by an architecture test. Widening it means first giving the new operation an idempotency story, which is the same order of work the original two required.

## D-153 — The idempotency key is assigned once, before the first attempt (P3-07)

`clientEventId` sits at the top level of a queue item, never inside the payload, and is carried unchanged through every attempt. The queue does not generate one.

That last part is the whole point. A queue that minted a fresh key per attempt would turn one Event into one row per retry — precisely the duplicate the key exists to prevent, produced by the mechanism meant to protect against it. It is also why the key is not copied into the payload: two copies are two things to keep in step, and the failure mode of them disagreeing is the same duplicate.

Where the key comes from is P3-08's, which joins "generate it, send it, queue the failure, replay it" into one path and proves end to end that a resent Event stays one row. P3-07 provides the half that has to be true first: the key survives the queue, a restart, and every retry.

## D-154 — A queued write is inspected before it reaches the disk (P3-07)

Enqueuing runs the payload through the same sanitization policy the server's write boundary uses. A confirmed credential is redacted where that is safe and refuses the enqueue where it is not, exactly as a write to the database would be.

A queue file is a stronger case for this than the database, not a weaker one. It outlives the process, sits in a directory chosen by whoever installed the adapter, and gets copied by whatever backs that directory up — and it is read by a person, in a text editor, at the moment something has gone wrong. A queue that skipped the boundary would be a durable copy of exactly what P3-01 through P3-03 exist to keep out.

The policy is the server's own, not a second implementation. `src/reliability/` never names the detector, and an architecture test pins that it builds the policy rather than reaching past it — the same rule that kept credential vocabulary inside one directory when the export service needed it (D-147).

The queue accepts structured Event and Verification intents and nothing else. There is no generic blob API, so there is no way to hand it a raw conversation, a log dump or a chain of thought and have it written down.

## D-155 — Files, one per item, replaced by rename (P3-07)

Not PostgreSQL: the queue holds writes that could not be stored, and the most ordinary reason for that is the database being unreachable, so a queue in the same database fails at the moment it is needed. Not memory: a session ends, a process restarts, a laptop sleeps, and a queue emptied by any of those has lost the Events it was holding. Not SQLite: a native module and a second storage engine, for a handful of small records that must survive a crash.

One file per item rather than one log. An append-only log needs a whole rewrite to update one attempt count, and one corrupt byte in the middle puts every record after it out of reach. Separate files make a success an `unlink`, an attempt an atomic replace of one small file, and a damaged record the loss of exactly that record.

Content is written to a temporary file in the same directory, flushed, and renamed over the destination. `rename` within a directory is atomic, so a reader sees the old file or the new one. The limit is stated rather than implied: the file's data is synced before the rename, but the directory entry is not, so a power loss in the instant after the rename can still lose it. Closing that costs a directory sync on every write and protects against the machine dying, which is not the failure this exists for.

Names come from a UUID this module generated. No part of a path comes from a caller, an owner, a Problem or a payload.

The directory is a required option with no default anywhere. Choosing it means choosing where somebody's unsaved work sits on their disk, and a library that guessed would write into a home directory, a working directory or a repository without being asked.

## D-156 — Nothing is thrown away, and the only deletion is a success (P3-07)

A delivered item is removed. Everything else is kept, including a permanent refusal and a run of attempts that used itself up. Both get a closed `terminal_failure` — `PERMANENT_RESPONSE` or `RETRY_EXHAUSTED` — and stop being attempted.

The spec's other half is that the user is told about important things that were not saved, and nothing can be reported that has already been deleted. Deleting on failure would make P3-09 impossible to implement honestly. There is no TTL that removes an old item either: age is not evidence that somebody stopped wanting their work.

A full queue refuses the new item rather than evicting the oldest. The oldest is the one that has been waiting longest to be saved, and dropping it silently is the outcome this whole task exists to prevent. Every limit — count, item size, total size — is the caller's to set; the library ships none.

There is no dead-letter subsystem, no management endpoint and no UI. A terminal item is a file in a directory, which is all P3-09 needs to find it.

## D-157 — A credential is never written down, and the owner is a guard rather than a key (P3-07)

No token, no header, no client id, and nothing derived from one, appears in a queue item. The stored shape is a closed set of eleven fields, asserted whole by a test rather than spot-checked. Delivery holds its own credential — it is the thing making the request — so the queue never sees one and cannot persist one.

That has a consequence worth naming: a credential rotated after an item was queued still delivers it. The item was tied to the owner whose memory it belongs to, not to the credential that happened to produce it, and an Event recorded before a revocation is still worth saving. A `401` therefore does not consume an attempt, does not make an item terminal, and does not modify anything; the drain stops and the caller tries again with a working credential.

`owner_id` is recorded and is checked against the context a drain is running as. It is not authorisation — the server decides that from the credential, as it always has (D-132) — it is a guard against handing one person's Event to a context established for someone else. On a mismatch nothing is delivered, nothing is counted and nothing is changed.

## D-158 — There is no timer, and the caller supplies the moment (P3-07)

`drain` takes the current time as an argument, and the queue records when an item may next be attempted. Nothing here sleeps, schedules or loops in the background.

A background timer in a library would keep running in a process with nothing to do, and it would have to be started and stopped by someone. It would also need a clock and a scheduler to test around — where this design needs neither: a ten-minute backoff is tested by passing a later date. That matters because `src/` had no clock and no timer at all before this task, and every timestamp in the system comes from PostgreSQL.

Backoff is a pure function: doubling from a base, capped at a maximum, with no jitter. Jitter spreads a thundering herd and there is no herd — one person's assistant, retrying one person's writes. A `Retry-After` is honoured when it asks for longer and ignored when it asks for less: being told to wait is information a client does not have, and being told to hurry by a server that has just failed is not something to accept.

Classification reads a closed outcome — a transport failure, or a status with an optional error code — and never an error message. A retry policy that read `error.message` would have its behaviour chosen by whatever wrote the message, and a proxy rewording a timeout would silently start dropping writes.

`500` is classified as retryable, and it is the ambiguous one: this server answers `500` both for a database that is briefly gone and for a bug in its own code, with nothing in the response to tell them apart. Retrying spends a bounded number of attempts on a bug and then stops, keeping the item; refusing would discard a write every time the database blinked. Bounded waste is the cheaper mistake.

## D-159 — A queued write for a deleted Problem stops, and nothing is resurrected (P3-07)

A `404` is permanent. The Problem was deleted, P3-05 leaves nothing to bring back, and retrying would ask for the same absent row forever.

The item becomes terminal and is kept. The `problem_id` is not rewritten, no Problem is created to hold the orphaned Event, and nothing about the deletion is undone — the delete was somebody's explicit request, and a queue that quietly re-created what it removed would be the worst possible answer to it. What remains is a record that this Event never reached anywhere, which is what P3-09 will report.

## D-160 — Replay must respect the Problem's current state, and that belongs to the adapter (P3-07)

`memory_write_enabled` is stored and settable and is not enforced on an append today; the spec treats it as a rule about whether an assistant *should* write, not something the server refuses. This task does not change that, and adding enforcement inside a retry task would be a Phase 2 decision made in the wrong place.

But it leaves a real question for whoever writes a delivery implementation, so it is recorded here as a standing rule: **a replay must respect the Problem's state at the time of the replay, not at the time of the enqueue.** An Event queued while writes were enabled, and delivered after the owner turned them off, is a write the owner asked not to happen. A delivery that blindly resends is doing so on the strength of a decision the owner has since reversed.

That belongs to Phase 5 and Phase 6, and to whatever P3-08 and P3-09 settle about how a caller learns what happened.

## D-161 — The write is made durable before it is attempted (P3-08)

The obvious arrangement is to send, and to queue only if sending fails. It is cheaper: a write that succeeds never touches the disk. It also has a window that loses data outright — the attempt fails, and the process ends before the failure has been written down. Nothing reached the server and nothing reached the queue, so the Event is gone with no trace. That window is small and it is exactly when a crash is most likely, because what takes a network attempt down is often what takes the process down.

So the order is enqueue, then attempt. After `enqueue` returns, every subsequent outcome leaves either a queue item or a row on the server:

| what happens | what survives |
| --- | --- |
| crash before the attempt | the item, replayed later |
| the attempt fails | the item, retried later |
| the attempt succeeds, then a crash before the file is removed | the item; the server keeps the first write |
| the server commits and the answer is lost | the same, and the same |

The cost is one small file written and removed for every Event that succeeds first time, paid on a path that is not the user's work.

An architecture test pins the order in the source rather than only the behaviour, because the behavioural difference appears only under a crash.

## D-162 — There is no fallback to sending when the write cannot be recorded (P3-08)

If the queue refuses the write — it is full, the disk errors, the payload holds a credential that cannot be removed — nothing is sent. There is deliberately no "queue unavailable, so send it directly anyway".

The fallback is tempting because it looks like resilience, and it reintroduces exactly the window D-161 closes, at the moment the system is least able to track what happened: a send with no durable record of it, made because the durable record could not be written. An ambiguous failure on that path leaves nobody able to say whether the write landed.

Recording a Memory is not the work the assistant is doing. Declining to send is a bounded, visible loss; an untracked delivery is an unbounded, invisible one. Two integration tests assert that the delivery is not called at all when the queue refuses — one for a full queue, one for a refused payload — so adding the fallback later fails them.

What the caller is told, and whether the person hears about it, is P3-09's.

## D-163 — Three layers, three responsibilities, one key (P3-08)

The coordinator assigns the idempotency key. The queue persists it and never changes it. The server refuses the second write that carries it.

The key is generated once, before the write is made durable, and the caller cannot supply one. That last part matters more than it looks: adapters in Phase 5 and Phase 6 will both submit writes, and if each carried its own key discipline, one of them would eventually regenerate on retry. The failure is invisible until there are duplicate rows, and by then the duplicates are in somebody's memory. Taking the decision away from the caller removes the possibility.

An architecture test pins that `generateClientEventId` is called in exactly one file. The queue must never call it: a fresh key per attempt turns one Event into one row per retry, which is the exact duplicate the key exists to prevent, produced by the mechanism meant to prevent it.

## D-164 — The first attempt carries the sanitized write, not the caller's input (P3-08)

`enqueue` inspects the payload and answers with the item it stored. That item — not the caller's original — is what the first attempt delivers.

Building a request from the original would put an unredacted credential on the wire exactly once, on the first attempt, and every retry would carry the redacted version. Once is once too many, and it is the attempt least likely to be looked at: a test that inspected retries would see nothing wrong.

It also means the write is the same object at every stage. The first attempt, the file on disk, the replay after a restart and the delivery a week later all carry identical bytes, so "the same Event, sent again" is true in a way that can be asserted field by field rather than by key alone.

## D-165 — A first attempt is a retry, run through the same code (P3-08)

`RetryQueue` gained `attempt(queueItemId, …)`, which processes exactly one item. The coordinator uses it for the first attempt; `drain` uses the same per-item function for everything due.

Two things follow. The owner guard, the classification, the backoff and the two terminal states exist once, so a first attempt cannot start behaving differently from a retry — which is the property the whole queue rests on. And the coordinator contains no retry logic at all: an architecture test asserts it never names `classifyDeliveryOutcome` or `nextDelayMs`.

`attempt` rather than `drain`, deliberately. Draining on submit would make "record this Event" mean "flush the backlog", handing the caller the latency and the failures of writes it knows nothing about, and making one slow item delay every subsequent Event. Draining stays something a scheduler does on purpose.

## D-166 — At least once, and observably once (P3-08)

The queue delivers at least once. It has no lock, so two processes over one directory can read the same item and both post it; a crash between a success and the `unlink` replays a write the server already has. Both are ordinary and neither is an error.

What makes that safe is not the queue. It is the unique index on `(owner_id, client_event_id)` with the first write kept, which has been there since Phase 1. The queue's contribution is to carry the same key every time.

The phrase "exactly once" is avoided on purpose. Deliveries are not exactly once and cannot be made so across a network. What is once is the **observable effect on Memory**: one row, whatever happened on the way there. A test drains the same item from two queue instances simultaneously and asserts one row, which is the honest version of the claim.

## D-167 — The proof is a lost answer, not a stopped server (P3-08)

The end-to-end tests do not stop the server. They post to a running one, wait for a real 201, and then report a transport failure anyway.

A test against a stopped server proves something weaker: nothing arrived, so a resend cannot duplicate. It would pass against an implementation that generated a fresh key on every retry, which is the bug this task exists to prevent. The interesting case is the one where the write *did* land and the client cannot tell — a timeout after a commit — because there the client's only safe move is to send again, and the second write is a real duplicate unless something refuses it.

Both Events and Verifications are proved this way, because the completion condition names both and because they take different code paths on the server: the Event insert uses `on conflict do nothing`, the Verification insert catches the unique violation.

## D-168 — The Verification insert's transaction caveat is left where it is (P3-08)

The two append paths deduplicate differently. `appendEvent` uses `on conflict … do nothing` and then re-reads; `appendVerification` lets the unique violation raise and catches it.

Measured during this task: a unique violation aborts the surrounding transaction, so any statement after it fails with `25P02` until the transaction ends. The Event path avoids that and needs to, because the close path appends Events inside a transaction. The Verification path would break the same way — but nothing calls it inside a transaction, and a replay is an ordinary HTTP append.

It is not fixed here. Changing a Phase 1 insert inside an idempotency task is the kind of unrelated edit that makes a change hard to review, and the difference is currently harmless. It is recorded as a standing note instead: **if `appendVerification` is ever called inside an explicit transaction, it must first be changed to the `on conflict do nothing` form.**

## D-169 — What the caller is told is mechanical and closed (P3-08)

`submitEvent` and `submitVerification` answer with one of four outcomes and the key: `DELIVERED`, `QUEUED`, `AUTH_REQUIRED`, `PERMANENT_FAILURE`. No response body, no error, no message, no credential.

`RETRY_EXHAUSTED` and a server refusal collapse into `PERMANENT_FAILURE`. They differ in why the item stopped, which the item itself records, and not in what the caller can do: neither will be retried, and both are still on disk.

Nothing here is phrased for a person. Whether an assistant should mention a queued Event, and how, is the failure-fallback contract in P3-09 — and it can only be written once there is something mechanical to write it against, which is what this is.

Submitting for an owner the delivery is not acting as throws rather than returning an outcome. That is a bug in the caller, not something that happened to a write; the queue's own owner guard exists for items read back off a disk, where the two can legitimately disagree.
