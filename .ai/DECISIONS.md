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
