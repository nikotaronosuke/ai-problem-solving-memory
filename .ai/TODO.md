# TODO

Updated: 2026-08-17

This is the working list, not a history. What was done in Phase 1 lives in git history, `.ai/DECISIONS.md` and the summary in `.ai/CURRENT.md`.

## DONE — Implementation Phase 2

Followed the private task breakdown:
`nikotaronosuke/ai-problem-solving-memory-spec/docs/implementation/phase2-task-breakdown.md`

Implementation Phase 1 is complete. All fourteen tasks are done and its Definition of Done was verified item by item. Implementation Phase 2 is now complete too; its fourteen tasks and Definition of Done are below.

### P2-01 — DONE
API application foundation.

Fastify 5 transport in `src/http/`, application services in `src/app/`, `/v1` versioning with `/health` outside it, one error envelope, owner-scoped authenticated request context, redacted logging, and a composition root that owns the pool, the listener and shutdown.

Definition of Done verified: `/health` and `/v1/me` work, invalid input returns a consistent `INVALID_REQUEST` envelope, and the transport layer imports neither `pg` nor `src/db/` — enforced by `tests/architecture.test.ts`, not convention.

### P2-02 — DONE
Project / Environment API.

Seven routes in the authenticated `/v1` scope: Project create, get, list and partial update; Environment create, get and list. Environments are nested under their project for create and list. No delete, and no Environment update.

Definition of Done verified against a real database: an owner creates, reads, lists and patches its own projects and environments; another owner gets 404 for each of read, patch, environment-create and environment-list, with a body identical to a resource that does not exist; patching an unknown id creates nothing; and transport reaches storage only through the application service, enforced by the architecture test.

Repository grew from ten operations to thirteen: `listProjects`, `updateProject`, `listEnvironments`.

### P2-03 — DONE
Problem create / get / list / partial update API.

Four routes: `POST|GET /v1/projects/:project_id/problems` and `GET|PATCH /v1/problems/:problem_id`. No delete, and no unscoped `/v1/problems` collection.

Definition of Done verified against a real database: an owner creates, reads, lists and patches its own problems; another owner gets 404 for read, patch and list, with a body identical to a resource that does not exist; patching an unknown id creates nothing; and every error uses the shared envelope.

Which fields a caller may set was decided here (D-054, D-055). A new Problem's starting state comes from the column defaults, and a patch may change eleven fields — `status`, `fix_kind` and `version` are not among them, because they belong to P2-06, P2-12 and P2-07 respectively. Sending one is a 400 rather than an ignored field.

Repository grew from thirteen operations to fifteen: `listProblems`, `updateProblem`.

### P2-04 — DONE
Event append / list API.

Two routes: `POST|GET /v1/problems/:problem_id/events`. No single-event read, no update, no delete.

Definition of Done verified against a real database: the same `client_event_id` sent again does not produce a second event, and a `HYPOTHESIS → ATTEMPT → DEAD_END → DISCOVERY → FIX` history appends and reads back in order.

The open question D-027 left is now settled (D-058): a retry returns the original event with the same 201 and the same body, the first write wins even if the retry's payload differs, and the key is the owner's rather than the problem's. The race is arbitrated by the unique index rather than by a read-then-write, and the concurrency test was confirmed to fail against the naive version before being kept.

Repository operations unchanged at fifteen — `appendEvent` and `listEvents` already existed.

### P2-05 — DONE
Verification append / list API.

Two routes: `POST|GET /v1/problems/:problem_id/verifications`. No single-verification read, no update, no delete, and no route reaching one through an Event.

Definition of Done verified against a real database: a FIX Event and a Verification are stored and read back as separate things, and successful and failed checks are distinguishable — `result` is a boolean at the HTTP boundary as well as in storage, with `null`, `"true"`, `1` and a missing field all refused rather than coerced.

The question D-060 deferred is now answered (D-063): a Verification retry replays the original and cannot change what the check found, in either direction. `DuplicateClientEventIdError` had no remaining thrower once both paths replayed, so it was removed rather than kept (D-064). Recording a successful Verification still leaves the Problem's status untouched (D-065).

Repository operations unchanged at fifteen — `appendVerification` and `listVerifications` already existed.

### P2-06 — DONE
Problem state transition service.

One route: `POST /v1/problems/:problem_id/status-transitions`, taking only `target_status`. It is the only way a status changes — the Problem PATCH still refuses `status`, and no append moves it.

Definition of Done verified against a real database: `VERIFIED` is unreachable without a successful Verification of the Problem's own, every move outside the matrix is refused, and a paused Problem resumes as either working status.

The rule itself is `src/domain/problem-status.ts` — plain data and plain functions, no HTTP, no storage. All 25 status pairs are checked against a matrix written out independently of the implementation, so an added or removed move is visible. The architecture test now also forbids a status literal anywhere in `src/` outside the domain.

A transition changes the status and nothing else: `fix_kind`, `confidence`, the flags and `version` all stay put, and a refusal writes nothing at all (D-069).

Repository grew from fifteen operations to sixteen: `updateProblemStatus`, deliberately separate from `updateProblem` whose input still has no status field.

### P2-07 — DONE
Optimistic locking on Problem.

`expected_version` is required on both Problem write paths — the ordinary PATCH and the status transition — and both increment the version on success and share the one column, so an edit and a transition conflict with each other rather than passing unseen.

Definition of Done verified against a real database: two writes from the same version leave one 200 and one 409, and Event and Verification appends keep working independently of the Problem's version. The three racing tests were confirmed to fail against a read-then-write first, where all three produce two 200s and a lost update.

`VERSION_CONFLICT` is a fifth error code at 409, naming no version (D-074). Ownership is settled before the version, and the version before the transition rule (D-075).

Events and Verifications are deliberately not versioned: their retry protection is `client_event_id`, which answers a different question (D-072).

Repository operations unchanged at sixteen — both write signatures gained `expectedVersion` rather than a new operation appearing.

### P2-08 — DONE
Relation entity / API.

A tenth migration adds the `relation_type` DOMAIN and the `relations` table; two routes follow: `POST|GET /v1/problems/:problem_id/relations`. Create and list only.

Definition of Done verified against a real database: a link cannot cross owners, cannot point at a Problem that does not exist, and cannot join a Problem to itself — each refused by the application and, for the last two, by the database as well.

Links may cross projects, which is the point (D-078). One row per link, both ends listed, rows reported as stored (D-077). A Relation does not touch either Problem and carries no evidence across — a Problem linked to a `VERIFIED` one still needs its own successful Verification (D-079).

Schema counts moved as expected: migrations 9 → 10, tables 6 → 7, DOMAINs 6 → 7, foreign keys 5 → 7, all still RESTRICT, still no native enum and no trigger. The exact-count tests were updated to the new figures while keeping the existing constraints asserted.

Repository grew from sixteen operations to eighteen: `createRelation`, `listRelations`.

### P2-09 — DONE
UsageLog.

An eleventh migration adds the `usage_action` DOMAIN and the `usage_logs` table; two routes follow: `POST|GET /v1/problems/:problem_id/usage-logs`. Create and list only.

Definition of Done verified against a real database: usage is recorded independently of the Memory itself — neither Problem changes — and which AI used what is traceable through `source_ai`, `action`, `memory_id` and `reason`.

It stayed explicit rather than becoming a read side effect (D-084), which was the question this task had to answer first. `source_ai` describes and never authorises (D-085). Cross-project usage is allowed and cross-owner refused, both ends checked. A Problem may be its own memory, unlike a Relation, because continuing an investigation under a different AI is real.

Global Audit stayed out (D-081): no tool, model or approval columns, and no audit route.

Schema counts moved as expected: migrations 10 → 11, tables 7 → 8, DOMAINs 7 → 8, foreign keys 7 → 9, all still RESTRICT, still no native enum and no trigger.

Repository grew from eighteen operations to twenty: `createUsageLog`, `listUsageLogs`.

### P2-10 — DONE
ChangeLog.

A twelfth migration adds the `change_logs` table; one route follows: `GET /v1/problems/:problem_id/change-logs`. Reading only — entries are written by the two mutating services, never by a caller.

Definition of Done verified against a real database: who changed what, when, and how is readable from the history, and the before/after policy does not contradict the secrecy requirement — free text is described rather than copied, checked by writing distinctive strings and asserting they appear nowhere in the stored `changes`.

The change and its record are one transaction (D-088). This is what the `DatabaseExecutor` seam was shaped for, and `src/db/transaction.ts` is the runner. Both rollback tests were confirmed to fail against a non-transactional context before being kept.

`changed_by` is now required on both Problem write paths, and is descriptive rather than authorising (D-091). One entry per mutation, bracketed by versions, with a unique constraint per `(owner, problem, to_version)` (D-089). Refused mutations record nothing.

Schema counts moved as expected: migrations 11 → 12, tables 8 → 9, foreign keys 9 → 10, all still RESTRICT. No new DOMAIN, still no native enum and no trigger.

Repository grew from twenty operations to twenty-two: `createChangeLog`, `listChangeLogs`.

### P2-11 — DONE
Memory control API.

One route: `PATCH /v1/problems/:problem_id/memory-control`, taking `expected_version`, `changed_by` and at least one control. No migration, no new column, no new repository operation.

Definition of Done verified against a real database: `memory_read_enabled=false` and `memory_write_enabled=false` are settable through the API, and suppression is not confused with `INVALID` — every test that sets one control asserts the other three did not move (D-094).

`invalidate: true` sets `freshness` to `INVALID` and nothing else; `invalidate: false` and `freshness` are both refused, because restoring a guessed freshness would overwrite a real distinction (D-095).

Basic modification remains the ordinary Problem update, which still accepts these fields (D-092). Both surfaces go through one extracted mutation path, so the locking, transaction and history cannot drift (D-093).

The controls are not authorisation and are not enforced yet: turning everything off leaves every read working and the controls reachable, and no endpoint starts refusing writes on the strength of a flag (D-096).

Schema and repository counts unchanged: migrations 12, tables 9, DOMAINs 8, FKs 10 all RESTRICT, 22 repository operations.

### P2-12 — DONE
Problem close/review API.

One route: `POST /v1/problems/:problem_id/close`, taking `expected_version`, `changed_by`, a `target_status` limited to the three conclusions, an optional `fix_kind` and four optional review summaries. No migration and no new column.

It was made a separate surface rather than metadata on a transition (D-097). The transition matrix and the `VERIFIED` gate were not re-litigated: close calls the same domain decision and the same evidence check, so a high-level surface cannot become a way around either (D-098). Working statuses are refused here.

`fix_kind` is finally written, here and nowhere else in this phase — absent leaves it, `null` clears it, and it stays a separate axis from status in both directions (D-099). The review summaries become ordinary Events in the existing vocabulary rather than a Review resource or new event types (D-100). Status, fix kind, the Events and the change log entry commit together in one transaction and one version step, verified by breaking each write in turn (D-101).

Two things surfaced while doing it. `appendEvent` used to recover from a duplicate `client_event_id` by catching the error and re-reading, which aborts an enclosing transaction; it now uses `on conflict … do nothing returning`, with P2-04's idempotency and concurrency tests re-run against the change. And Events written in one transaction share a `created_at`, so the four review Events have no order among themselves — accepted rather than fixed, since each carries its own type (D-102).

Schema counts unchanged: migrations 12, tables 9, DOMAINs 8, FKs 10 all RESTRICT. Repository grew from twenty-two operations to twenty-three: `updateProblemConclusion`.

### P2-13 — DONE
API contract / schema documentation.

One route: `GET /openapi.json`, outside `/v1` and unauthenticated. One new runtime dependency, `@fastify/swagger` in dynamic mode. No migration, no new repository operation, no business behaviour changed.

The route schemas stay the only contract. Generation reads what Fastify already validates and serialises through, so the document cannot describe something the server does not enforce (D-103). Nothing generated is committed, so there is no second artefact to update (D-104). OpenAPI 3.1, because the runtime schemas are plain JSON Schema and 3.0 would have required rewriting live validation into its `nullable` dialect (D-105).

Definition of Done verified against the generated document rather than the source: exactly 25 operations with unique stable operationIds (D-108), every enum set, required field, `minProperties` and `additionalProperties: false` intact, the five error codes, and `GET /openapi.json` byte-identical to `app.swagger()`. 70 tests, and a route schema loosened by accident fails them (D-111).

One real finding while implementing it. `register` is deferred, so the generator's `onRoute` hook does not exist until `ready()` — a route added directly to the instance before then is silently absent from the document. `/health` was missing for exactly that reason. Every route now goes through a queued plugin, and the inventory test is what caught it (D-106).

No security scheme is declared, because no client credential contract exists yet (D-110). No Swagger UI (D-109).

Schema and repository counts unchanged: migrations 12, tables 9, DOMAINs 8, FKs 10 all RESTRICT, 23 repository operations. Runtime dependencies 2 → 3.

### P2-14 — DONE
Phase 2 E2E.

`tests/e2e/phase2.e2e.test.ts`. 19 tests: one scenario in 14 ordered steps, then five refusals. No migration, no repository change, no production change of any kind.

The required flow runs over real HTTP against real PostgreSQL: project and environment, a Problem started at INVESTIGATING/version 1, `HYPOTHESIS → ATTEMPT → DEAD_END → DISCOVERY → FIX`, FIX_CANDIDATE, a successful Verification that deliberately concludes nothing on its own, then VERIFIED with `ROOT_FIX` through the close route. Then a second project, a cross-project `SIMILAR_TO` relation, a UsageLog naming the first Problem as memory used, a memory control change, an ordinary edit, and a final re-read of everything from the database rather than from any earlier response.

All five negative categories: VERIFIED refused without a check of the Problem's own, a stale version refused with 409, the owner boundary held by read, by write and sideways through a relation, a resent `client_event_id` returning the original write, and a self-relation refused.

What it adds over the endpoint suites is continuity — the id one call returns is the id the next accepts, and the version handed back is the version the next write must present. Nothing is hard-coded between steps. Confirmed to discriminate: removing the Verification step makes VERIFIED unreachable in the real sequence and everything downstream fails.

The fixture generates its own owners, never the developer's, cleans up only what it created, and does not assume an empty database.

Schema and repository counts unchanged: migrations 12, tables 9, DOMAINs 8, FKs 10 all RESTRICT, 23 repository operations.

## PHASE 2 — COMPLETE

Every item of the Definition of Done is satisfied and verified against a real database:

- Core JSON API works as one flow, not only per endpoint
- State transitions follow the matrix, and `VERIFIED` cannot be reached without evidence
- Relation, UsageLog and ChangeLog all exist and are exercised in sequence
- Optimistic locking holds across every Problem write path
- The owner boundary holds, and reveals nothing it was protecting
- The API contract is fixed and published as OpenAPI 3.1, generated from the runtime schemas
- The Phase 2 E2E passes automatically

1793 tests across 60 files.

## NEXT — Implementation Phase 3

Follow the private Phase 3 breakdown:
`nikotaronosuke/ai-problem-solving-memory-spec/docs/implementation/phase3-task-breakdown.md`

### P3-01 — DONE
Sanitization boundary.

`src/sanitization/`: a policy interface, a structure-preserving traversal, and a `Proxy` that wraps the repository. No migration, no new repository operation, no new dependency, no new route, no API change.

Every write path goes through it because a service never constructs a repository — it is handed one, and `app/request-context.ts` is the only place either the ordinary or the transactional repository is built. Both are wrapped, so an adapter added later inherits the same checkpoint rather than needing to remember one (D-112).

Nothing is checked by field name. The traversal reaches every string at any depth — values and the keys naming them — including inside an Environment snapshot, whose shape is whatever the caller composed (D-113). It rebuilds rather than mutates and preserves key order, array length, `null`, and keys whose value is `undefined` — so installing it changed no behaviour, and all 1793 Phase 1/2 tests pass unaltered.

The shipped policy decides nothing, deliberately. Detection is P3-02 and refusal or redaction is P3-03; a provisional secret check shipped as production logic would be worse than an honest absence (D-114). A refusal carries a safe locator and whether a key or a value was refused — both generated by the boundary, neither containing anything a caller sent or a policy supplied — and maps to the existing `INVALID_REQUEST` rather than adding an error code (D-115, D-118, D-119).

Two rounds of external review found four holes, all closed without weakening any existing guard, and each reproduced first so the new tests were confirmed to fail against the old behaviour.

First round: object keys were never inspected, and were used raw as locator segments, so a secret in a snapshot key both bypassed the boundary and could be logged by it (D-116). And a `reject` outcome carried free text that reached the operational log, making "a refusal never carries the value" a matter of policy-author discipline rather than structure (D-117).

Second round, on the fix itself: rendering *approved* keys into the locator was still wrong, because a secret detector keeps an email address for being not-a-secret, which says nothing about whether it may be copied into a log — persistence-safe and log-safe are different questions (D-118). And `policy.name` was still free text flowing into every refusal and log line, the same leak one field along (D-119).

The pattern, stated once because it recurred: every string someone outside the boundary could choose eventually reached a log. A refusal is now described entirely by values the boundary itself produced.

Definition of Done verified by breaking it: unwrapping the transactional repository, making the traversal shallow, and misclassifying one write as a read each fail multiple guards — including the architecture test that every handout is wrapped, and the integration test that a refused close leaves nothing behind.

Schema and repository counts unchanged: migrations 12, tables 9, DOMAINs 8, FKs 10 all RESTRICT, 23 repository operations, 3 runtime dependencies. 1880 tests across 63 files.

### P3-02 — DONE
Secret detection.

`src/sanitization/secrets/`: a detector, a finding type and a policy adapter. No migration, no repository change, no route, no new dependency, and no change to the P3-01 boundary.

Detection and action are deliberately separate (D-120). The detector answers what a string is; the policy turns that into an outcome, and P3-03 changes the second without reopening the first.

Nothing is judged by shape. Every rule needs a signal that means credential — a PEM private-key header, a JWT whose header actually decodes, an `Authorization` or `Cookie` line, a credential-named assignment, or a credential-named field in the caller's own structure. Entropy and length are not evidence, because they describe UUIDs, commit SHAs and evidence references at least as well as they describe secrets (D-122). The known cost is that a bare credential with no context is not found; the specification's answer to that is the adapter-side pass, and this is the server-side re-check.

Context comes from P3-01's structured path: `{"api_key": "..."}` is recognised by the nearest key, the association survives an array, and it does not carry past an unrelated field. Keys are inspected as content too, so a credential written into a key is found.

A finding carries a category and a certainty and nothing else — no matched text, no excerpt, no offset, no hash (D-121). Confirmed findings are refused; suspected ones are kept and not logged, because refusing configuration templates and documentation examples would make the record unusable (D-123). The refusal is P3-01's: safe locator, key-or-value, no category, no policy name.

A second review round found two holes and both are closed (D-124). Value shape was gating explicit credential names, so `PASSWORD=letmein`, `API_KEY=abcdef` and a spaced passphrase were stored — "meaning, never shape" had been applied in one direction only. And `Authorization` was pattern-matched rather than parsed, so `Authorization: disabled`, a bare `Authorization: Bearer` and `Authorization: Bearer [REDACTED]` were all refused. Names now carry a strength, content is read through one shared function, headers are parsed, and each line is judged by one rule. Both were reproduced against the committed code first.

Definition of Done verified against a real database, not just against a 400: every column of every table is scanned for each secret marker after the suite runs. Seven deliberate mutations — removing bearer, private-key, structured-context and `.env` detection, breaking the key connection, keeping confirmed findings, and loosening the guard to treat long hex as a token — each fail between 5 and 35 of the new tests.

The detector is also the default policy, so all 1904 pre-existing tests ran through it unaltered as a false-positive corpus.

Schema and repository counts unchanged: migrations 12, tables 9, DOMAINs 8, FKs 10 all RESTRICT, 23 repository operations, 3 runtime dependencies. 2096 tests across 66 files.

### P3-03 — DONE
Redaction / reject policy.

`src/sanitization/secrets/` gains `patterns.ts` and `redactor.ts`. No migration, no repository change, no route, no new dependency, and the P3-01 boundary is untouched.

A shared parser locates credentials and reports spans; the detector throws the positions away, the redactor keeps them, and the policy decides (D-125). Spans never leave the directory — an architecture test pins that they appear in exactly three files, because an offset and a length are information about a secret.

Confirmed credentials in a value are redacted where that is safe: partial replacement in prose, whole-value replacement under a credential-named field, every occurrence rather than the first. Refused where it is not — an unterminated PEM block has no knowable end, and a key is refused because a replacement can collide with an existing key and merge two fields silently (D-126). Suspected findings are still kept.

The redacted text is then shown to the detector again, and if a confirmed credential survived the write is refused anyway (D-127). Redaction is idempotent: the marker is itself a recognised placeholder.

`Set-Cookie` attributes are no longer read as cookie values — only the first pair is the credential — which fixes a false positive that refused `Set-Cookie: sid=[REDACTED]; Path=/`.

A post-merge review found one regression: a suspected inline assignment answered before the strong structured context, so `{"api_key": "token=morning"}` was kept in plaintext. Certainty is now the strongest evidence available for the string at its site, never the first parser to return (D-129). Reproduced first; with the old ordering restored, the database sweep itself fails.

Two pre-sanitization log paths were closed. Ajv names the offending property on an `additionalProperties` failure, so logging the validation error wrote a caller-chosen key into the operational log before sanitization had run at all (D-128). The malformed-JSON branch got the same treatment defensively; Fastify 5 replaces that message and it was not observed to leak.

Definition of Done verified against a real database: every marker absent from every column of every table, the redacted text present in its place, and absent from responses, the change log and the operational log. Six deliberate mutations — disabling partial redaction, redacting only the first of several, removing the post-check, restoring `Set-Cookie` attribute handling, and restoring both `{err}` log lines — fail between 1 and 20 of the new tests; the parse-error one does not, for the reason above.

Schema and repository counts unchanged: migrations 12, tables 9, DOMAINs 8, FKs 10 all RESTRICT, 23 repository operations, 3 runtime dependencies. 2155 tests across 67 files.

### P3-04 — DONE
Credential separation.

One migration, the first since P2-10: `clients` and `client_credentials`. A client belongs to an owner; a credential belongs to a client and does *not* carry `owner_id`. Duplicating it would create a second answer to who owns a credential, and the two answers can disagree (D-130).

A request presents `Authorization: Bearer mem_<lookup>_<secret>`. The lookup half is a public selector that finds one row; the secret half is compared, in constant time, against a SHA-256 digest — the raw token is never stored and cannot be reconstructed (D-131). A valid lookup with the wrong secret is refused exactly like a lookup that matches nothing, which is the mutation worth keeping: without the digest comparison the lookup alone would be the credential.

`MEMORY_OWNER_ID` no longer establishes an HTTP context (D-132). Knowing an owner's identifier is not holding a credential for it, and a fallback would have made an identifier that lives in configuration files into a password that cannot be revoked. It remains local tooling for bootstrap and for issuing credentials. Thirty-eight test sites depended on the old path; they moved to an explicit `tests/support` double rather than leaving an optional fallback in production, because a bypass kept for the convenience of tests is a bypass.

Every request is verified against the database, with nothing cached anywhere, so revocation takes effect on the next call rather than at the next restart (D-133). Rotation follows from the same shape: a client may hold several credentials, and revoking one leaves the others working.

The credential store is its own repository, not part of `MemoryRepository`, and is deliberately not wrapped by the sanitization boundary (D-134). It runs before an owner exists to scope to, and pointing a secret detector at a digest is at best wasted work and at worst a policy redacting the one column that must survive verbatim.

Issuing and revoking are local commands rather than HTTP endpoints. Revocation takes a credential id, never a token, so revoking one does not put it in shell history.

The OpenAPI document gained the scheme it refused to invent in P2-13 (D-135): `memoryToken`, required by default so a route added without a thought about authentication is documented as protected, with `/health` the only exemption. Contract version 0.1.0 → 0.2.0.

Two findings came out of the mutation proofs rather than the implementation, and both fixed a test rather than the code. Storing the secret's own bytes in place of a digest passed all 52 credential tests, because `to_jsonb` renders `bytea` as hex and no substring search for a base64url secret matches it; the test now decodes the column and compares against a digest computed independently of the function under test. And removing the `Authorization` redaction path changed nothing observable, because Fastify's own `req` serializer never writes headers — that control is dormant defence for the moment a serializer changes, so it is pinned structurally and the comment says why a behavioural test cannot catch it.

Nine deliberate mutations fail between 1 and 8 tests each: the environment fallback restored, the revocation check removed, the digest comparison removed, a reversible digest, the hook not passing the header on, the redaction path removed, redaction marking instead of removing, revoke taking down a whole client, and revoke ignoring the owner.

Schema and repository counts: migrations 13, tables 11, DOMAINs 8, FKs 12 all RESTRICT, 23 repository operations (unchanged), 3 runtime dependencies (unchanged). 2220 tests across 69 files.

### P3-05 — DONE

Physical delete path.

No migration. `DELETE /v1/problems/{problem_id}?expected_version=N`, one new database module, one repository operation, one service, one route.

The unit is a Problem and everything referring to it: its events, verifications and change log, and every relation and usage log naming it — including the ones pointing in from a Problem that survives (D-136, D-138). A surviving Problem can therefore lose part of its own history, which is the accepted trade rather than an oversight: a request to remove something outranks another record's account of it. Nulling those references would have meant making a NOT NULL composite foreign key nullable in order to keep a row whose subject no longer exists.

Physical, not soft (D-137). No `deleted_at`, no `DELETED` status, no tombstone, no delete audit table, and no `changed_by` on the request. Every path already resolves the Problem before doing anything, so removing the row produces the right 404 everywhere without new code — and the same 404 a Problem that never existed gets. A soft delete would have needed every read, list and append to remember to exclude the row, with the one that forgot serving exactly what the delete existed to remove.

Six statements in one transaction, leaves first, every one naming the owner. The order lives in `src/db/problem-deletion.ts` and nowhere else. RESTRICT stays and does real work here (D-139): a later table that references `problems` without joining the delete path makes the final statement fail on its foreign key and rolls the transaction back. That failure is deliberately not translated into a version conflict — it is a programming mistake, and reporting it as a stale version would hide the bug behind a plausible retry.

`expected_version` is required and guards less than it appears to (D-140). It catches a change to the Problem; it does not catch an appended Event, because appending does not move the Problem's version and Phase 2's append-only design was not reworked to make it. Recorded plainly rather than implied. No confirmation flag: any client that can send the delete can send one, so explicit user intent stays the caller's responsibility.

The row lock is honest about its own value: correctness comes from the version predicate, which holds without it; the lock adds determinism. Removing it fails no behavioural test, because deleting the Problem locks the same row moments later, so an architecture test pins it instead.

Project and Environment survive, deliberately, even when the deleted Problem was the last one using them. Clients and credentials are a different boundary and no foreign key connects them.

Secret purge proved against a real database: a credential marker written into every free-text surface with raw SQL — historical data simulation, since P3-02 would refuse it today and was not weakened — then deleted through real HTTP and swept out of every Memory table. The marker is asserted present before the delete, and another owner holding the same string keeps it.

Eleven deliberate mutations fail between 1 and 12 tests each: dropping the `memory_id` side, dropping the `to_id` side, dropping the change log delete, deleting the parent first, dropping the version check, dropping an owner scope, answering a foreign owner as a conflict, echoing the deleted Problem in the response, taking Environments too, dropping the row lock, and removing the transaction.

The last of those found a real gap rather than confirming a guard: replacing `runInTransaction` with a direct repository call passed all 59 tests, because a successful delete looks identical either way and nothing tested an unsuccessful one at that seam. A service-level test now pins it.

Two counts corrected from the pre-implementation investigation: `problems` has **seven** incoming foreign keys, not six — `relations` and `usage_logs` contribute two each, and counting tables undercounts exactly the references that point in from a surviving Problem. That inventory is now pinned literally, so a new reference has to be considered rather than noticed later (D-141).

Schema unchanged: migrations 13, tables 11, DOMAINs 8, FKs 12 all RESTRICT, 3 runtime dependencies. Repository operations 23 → 24. 2254 tests across 72 files.

### P3-06 — DONE

Export.

No migration. `GET /v1/export`, one new database module, one repository read, one service, one route, one new error code.

The whole of an owner's Memory as one JSON document: eight collections carrying every column of their table minus `owner_id`, with `source_owner_id` once at the top (D-144). Import is not implemented and was not asked for — §25.9 excludes it from the Core MVP completion condition, and the completion condition here is that the *format* is restorable (D-142).

That claim is proved rather than asserted. An artifact is handed back to PostgreSQL, unpacked with SQL into a second owner, and the restored owner is exported again and compared collection by collection. Raw SQL deliberately: a TypeScript restore helper would become the unreviewed specification for the real importer. The proof also removes the source rows first, so the artifact is shown to stand alone.

Every identifier survives, `client_event_id` included, so a restored Memory keeps its idempotency (D-145). Restoring beside the rows it came from collides on the primary key, which is pinned as correct behaviour rather than worked around.

`schema_version` is `"1"`, its own constant (D-143). P3-05 moved the API contract 0.2.0 → 0.3.0 without changing the export by a byte; sharing the number would have told every artifact holder their format had changed.

One SQL statement builds the document (D-146). That is what makes it a snapshot — eight reads would take eight snapshots, and a delete between the third and fourth yields an artifact describing a state that never existed — and it is also what keeps the precision: timestamps formatted to six digits by PostgreSQL, snapshots embedded as JSON with numbers past `Number.MAX_SAFE_INTEGER` intact, the whole thing fetched as text and sent with the compiled serialiser overridden. The oracle in every precision test is the database's own text, so a broken export cannot agree with a broken expectation.

A Memory holding a confirmed credential is refused with `409 EXPORT_BLOCKED` and not redacted (D-147): a redacted artifact stops being a copy of the database, and an exported one puts a credential in the largest file the system produces. Suspicion keeps, as at the write boundary. Exporting writes nothing back under any outcome (D-148), pinned by an architecture test that the module contains no write at all. Credentials are absent and unreachable (D-149).

Thirteen deliberate mutations fail between 1 and 5 tests each: dropping `schema_version`, dropping a collection, dropping a field, unscoping a collection from its owner, mixing client rows in, removing the ordering, formatting timestamps to milliseconds, fetching the document as `json` so the driver parses it, re-serialising in the route, removing the secret guard, redacting instead of refusing, writing back during an export, and splitting the statement in two.

The last is worth recording precisely. Splitting the snapshot is caught, but by the precision tests rather than by a consistency one — any split that routes the document through JavaScript damages the timestamps first. A split that somehow preserved precision would be caught only by the architecture test that pins the single statement. The concurrency tests prove the property holds; they cannot prove which mechanism provides it.

One finding came out of the work and stands: a request body is parsed by `JSON.parse` before the server sees it, so a number too large for JavaScript cannot be stored through the API at all — the export is lossless with respect to what the database holds, which is the strongest available claim.

A second was raised as a security blocker in review and corrected before P3-07. `AWS_SECRET_ACCESS_KEY=…` was not detected as a credential — `accesskey`, `secretkey` and `securitytoken` were exact names in the P3-02 vocabulary rather than suffixes, so every provider-prefixed form, which is every real one, read as ordinary prose. Because the export inspects with the same detector, a Memory holding one was exported in full: reproduced at 200 with the raw secret in the response body before anything was changed. Three compounds became suffixes, chosen one at a time against the vocabulary's own test (D-150); `accesskey` deliberately stayed exact, because HTML gives every element one. Removing the correction returns the five export tests to 200 with the secret in the body, and also fails the write-boundary database and response sweeps.

Schema unchanged: migrations 13, tables 11, DOMAINs 8, FKs 12 all RESTRICT, 3 runtime dependencies. Repository operations 24 → 25, of which twelve are reads. API contract 0.3.0 → 0.4.0, operations 26 → 27. 2294 tests across 75 files.

### P3-07 — DONE

Retry queue.

No migration, no new dependency, no HTTP surface. One new directory, `src/reliability/`, which is deliberately not part of the Memory Server.

That placement is the task's main decision (D-151). E2E-7 asks that work continue *when the Memory Server is down*, and a queue inside the server never receives the request it was supposed to hold — it rescues one failure out of ten, the case where HTTP still answers and the database is briefly gone. So the queue is a client-side library, imported by nothing the server runs, with an architecture test that fails if that changes. It lives in this repository because the adapters that will use it are Phase 5 and Phase 6 and the knowledge it encodes is this project's; the task list placing it in Step 3, before any adapter exists, is a real tension and is recorded rather than reinterpreted.

Two operations may be queued and no others (D-152): `appendEvent` and `appendVerification`, which are exactly the writes carrying `client_event_id` where the database keeps the first write. Delete must never be added. The key is assigned once before the first attempt, kept at the top level rather than inside the payload, and never regenerated (D-153) — a queue minting a fresh one per attempt would produce the duplicate the key exists to prevent.

Every write is sanitized with the server's own policy before it reaches the disk (D-154). A queue file outlives the process, sits where an installer put it, and is read in an editor when things have gone wrong, so it is subject to the same rule as the database — for stronger reasons.

Storage is one JSON file per item, written to a temporary file, flushed, and renamed into place (D-155). Not PostgreSQL, which shares the failure domain being worked around; not memory, which loses the Events on restart; not SQLite, which is a native module for a handful of small records. The fsync boundary is stated in the module rather than implied. The directory is a required option with no default anywhere.

Only a success deletes anything (D-156). A permanent refusal and an exhausted retry both become terminal and stay on disk, because P3-09 cannot report what has been deleted; a full queue refuses the new item rather than evicting the oldest.

No credential is ever written down (D-157), and the stored shape is eleven fields asserted whole. A rotated credential therefore still delivers what was queued before it. `401` spends no attempt and stops the drain. `owner_id` is a guard rather than authorisation.

There is no timer (D-158). `drain` takes the moment as an argument, which is why a ten-minute backoff is tested by passing a later date and why `src/` still has no clock of its own. Classification reads a closed outcome and never a message; `500` retries, with the ambiguity written down rather than hidden.

A `404` from a deleted Problem is permanent, the item is kept, and nothing is resurrected (D-159).

Proved against a real server on a real port that is really stopped: the write fails as a transport failure, the caller's own work finishes without an exception, the item survives being read by a second queue instance on the same directory, the server comes back, an explicit drain delivers it, and the row in the database carries the key generated before the first attempt. A separate test revokes nothing and simply presents a different credential, which is refused as `AUTH_REQUIRED` and then delivered under the owner's real one.

Fourteen deliberate mutations fail between 1 and 6 tests each: treating `503` as permanent, `400` and `404` as retryable, zeroing the backoff, never incrementing the attempt count, regenerating the key, dropping the max-attempts check, not removing a delivered item, removing the owner guard, skipping sanitization, adding a credential field, adding a raw error message, swapping the filesystem for memory, and importing the queue from the server's entry point.

Schema unchanged: migrations 13, tables 11, DOMAINs 8, FKs 12 all RESTRICT, 25 repository operations, 3 runtime dependencies, OpenAPI 0.4.0 with 27 operations. 2391 tests across 78 files.

### P3-08 — DONE

Idempotent replay.

No migration, no dependency, no HTTP surface, and nothing changed on the server. One new file in `src/reliability/` — the coordinator — plus one method on the queue.

The decision the task turns on is the order (D-161): the write is made durable **before** it is attempted. Sending first and queuing on failure is cheaper and loses data in a window that is small and badly timed — the attempt fails, the process ends before the failure is written down, and the Event is gone with no trace anywhere. Enqueue-then-attempt means every outcome after `enqueue` leaves either a queue item or a row on the server.

There is deliberately no fallback that sends when the queue refuses the write (D-162). It looks like resilience and reintroduces exactly that window at the moment the system can least track what happened. Two integration tests assert the delivery is never called — one for a full queue, one for a refused payload — so adding the fallback later fails them.

Three layers, one key (D-163). The coordinator assigns `client_event_id` once and the caller cannot supply one; the queue persists it and never changes it; the server refuses the second write carrying it. Taking the decision away from callers is what stops two adapters each inventing a key discipline and one of them regenerating on retry — a failure invisible until there are duplicate rows in somebody's memory.

The first attempt carries the sanitized item `enqueue` returned, not the caller's input (D-164), so an unredacted credential cannot reach the wire on the one attempt least likely to be inspected. `RetryQueue.attempt` processes a single item through the same per-item function `drain` uses (D-165), so a first attempt and a retry are one implementation, and the coordinator holds no retry logic at all.

The end-to-end proof does not stop the server (D-167). It posts to a running one, waits for a real 201, and reports a transport failure anyway — the timeout-after-commit that a stopped server cannot reproduce and that a fresh-key-per-retry implementation would survive. Both Events and Verifications are proved this way, because the completion condition names both and their inserts take different paths.

A post-merge review found one regression, fixed before P3-09 (D-170). `attempt` reached delivery without the eligibility gate `drain` applies, so an item id could resend a write the server had permanently refused, resend one whose attempts had run out, or ignore a running backoff — the delivery callback fired in all three, measured before the fix. The gate is now one function both entry points run, and the mapping to a submit outcome is asserted against every refusal rather than described in a comment. A comment calling delivery "exactly once" was corrected to match D-166.

Ten deliberate mutations fail between 1 and 5 tests each: regenerating the key on retry, generating a second key at enqueue, attempting before the write is durable, delivering the caller's raw input, draining the whole queue on submit, routing a Verification as an Event, dropping the owner check, weakening the server's `on conflict` clause, giving `attempt` its own classification, and leaving a delivered item on disk. The first two fail with **two rows in the database**, which is the only failure that matters here.

One measurement is recorded rather than acted on (D-168): a unique violation aborts its transaction, so `appendVerification` — which catches the violation rather than avoiding it — would fail on the statement after it if it were ever called inside an explicit transaction. Nothing does, and a replay is an ordinary HTTP append. A standing note says what to change if that stops being true.

Schema unchanged: migrations 13, tables 11, DOMAINs 8, FKs 12 all RESTRICT, 25 repository operations, 3 runtime dependencies, OpenAPI 0.4.0 with 27 operations. 2424 tests across 80 files.

### P3-09 — DONE

Failure fallback contract.

No migration, no dependency, no HTTP surface, nothing on the server. One new file in `src/reliability/`, plus a storage boundary and one durable field.

The task is a contract rather than an engine: what already happened — a submit outcome, a queue that would not take a write, a search reporting itself unavailable — becomes a decision the caller acts on. No search engine, adapter, HTTP client, notification renderer or scheduler was added.

The absorbed failures are named one at a time (D-171): a submit outcome, `QueueCapacityError`, `SanitizationRejectedError`, `QueueStorageError`, `UNAVAILABLE`. Everything else propagates, including an owner mismatch and a delivery that threw where its contract says to return an outcome. `catch (error) { carryOn() }` would satisfy the requirement in one line and turn every bug in the codebase into silence, so the tests for what still throws are as thorough as the ones for what does not, and `continueMainWork` is typed `true` so there is no branch to write.

Filesystem detail stops at the queue's edge (D-172). Each `fs` call is wrapped individually into a `QueueStorageError` carrying one of three operation kinds and nothing else — no path, no `errno`, no syscall, no OS message, and deliberately no `cause`, because a Node filesystem error's message *is* the absolute path it failed on and an error holding one travels wherever errors travel. Wrapped per syscall rather than per method, so a mistake in this module's own logic still surfaces as itself.

Importance comes from the Problem and nowhere else (D-173), is recorded when the write is made rather than looked up later (D-174), and lives in the queue file — because the moment a queued write runs out of attempts is usually a moment the server is unreachable, which is why it ran out. That made the queue format version `'2'` (D-175); leaving it at `'1'` would have left a reader unable to tell "not important" from "written before the field existed".

A queued write is not a failure to report (D-176). `QUEUED` and `AUTH_REQUIRED` are silent even for an important Problem: there is a durable copy and a recovery path, and announcing it would interrupt somebody every time a laptop lost its network. One notice kind exists (D-177), carrying the operation and an opaque handle and nothing from the write itself — in the case that matters most, the write was refused precisely because its content should not travel. The handle is the same whether the failure is reported immediately or found on disk later (D-178), which is what P3-07's refusal to delete a terminal item was for.

An empty search result is an answer; a search that did not run is not (D-179). And the library answers rather than running the caller's work (D-180) — continuation is proved with a caller-side sentinel, which is what an adapter will look like.

A third review found one more, fixed before P3-10 (D-183). A missing queue item was being reported as a confirmed failure to save — but the ordinary reason an item goes missing is another instance having delivered it and removed the file, which P3-08 supports on purpose. Reproduced with a real server and the row in the database while the caller was told the Event was lost. `UNKNOWN` now exists in both the submit outcome and the write state, claims nothing, and produces no notice; `UNSAVED` is reserved for the settled case.

A post-merge review found two blockers, both fixed before P3-10. Every `QueueStorageError` was being called a write that was never saved, including one raised after the server had accepted the write and only the cleanup failed — measured producing `UNSAVED` and an important-unsaved notice for an Event sitting on the server (D-181). And the operation and the Problem's importance were given twice, once to the submission and once to the decision, so an important Event could be described as routine and produce no notice at all (D-182). The public API is now operation-specific and takes the caller's own input.

Fourteen deliberate mutations fail between 1 and 5 tests each: throwing on an unavailable search, treating an empty result as unavailable, notifying on `QUEUED`, notifying on `AUTH_REQUIRED`, notifying routine failures, not notifying important terminal ones, absorbing everything with a catch-all, putting the write's summary in a notice, attaching the raw error to `QueueStorageError`, dropping `problem_important` from the file, leaving the schema version at `'1'`, deleting terminal items, dropping the operation from the dedup handle, and reporting an unreadable queue as important-unsaved.

Schema unchanged: migrations 13, tables 11, DOMAINs 8, FKs 12 all RESTRICT, 25 repository operations, 3 runtime dependencies, OpenAPI 0.4.0 with 27 operations. 2477 tests across 81 files.

### P3-10 — DONE

Logging policy.

No migration, no dependency, no HTTP surface change. The operational log stopped being a filter and became an allowlist (D-184): a serializer builds a new object from named fields rather than removing fields from Fastify’s, and every deliberate call site passes a closed set of keys.

Five leaks were measured against the previous configuration before anything changed — the raw URL, so a credential in a 404 path or a query string was written verbatim; the caller-chosen `Host`; the remote address and port; the driver’s message behind a failed health probe, naming a database host, a port and an account; and every `Error` handed to the logger, which Pino expands into message, stack, `cause` and every enumerable property. A `pg` unique or check violation carries the offending row in `detail`, which for this schema is Memory prose.

Fastify’s lifecycle logging was kept and its serializers replaced (D-185): `{ method, route, operation }`, `{ statusCode }`, `{ failure }`. `disableRequestLogging` is deprecated in Fastify 5.11.3 and its replacement is a server option, which would have split the policy away from the one function every leak test runs as production configuration.

Both the error sink and the error serializer are closed (D-186), and the mutations show why both: handing the error back with the serializer in place leaks nothing, removing the serializer with no call site passing an error leaks nothing, removing both leaks everything.

Health reports a closed reason rather than the driver’s words (D-187) — the one leak a serializer cannot close, because it is an explicit call site handing a free string to a permitted field. `request_id` is the only identifier logged, and a caller cannot supply one (D-188). Startup failures before the logger exists now print one fixed sentence (D-189), proved by running the real entrypoint in a child process. Administrative CLI output stays what it was (D-190), and nothing new logs (D-191).

Eighteen mutations fail between 1 and 7 tests each: the raw URL, the `Host`, the remote address, headers, the request body, the response body, the removed error serializer, the restored `{ err: error }`, both of those together, the driver message in health, the application refusal’s message, the sanitizer locator keeping a caller’s key, an auth reason carrying what was presented, `QueueStorageError` recovering its `cause`, a caller-chosen request id, the startup boundary printing its error, configuration read outside that boundary, and the removed not-found handler letting Fastify log the raw path itself.

Schema unchanged: migrations 13, tables 11, DOMAINs 8, FKs 12 all RESTRICT, 25 repository operations, 3 runtime dependencies, OpenAPI 0.4.0 with 27 operations, export schema "1", queue schema "2". 2542 tests across 83 files.

### P3-11 — DONE

Security tests.

**No production source changed.** No migration, no dependency, no endpoint, no OpenAPI change. P3-11 is a regression proof over what P3-01 through P3-10 built (D-192), and the investigation attacked the running system before assuming that — 21 cross-owner operations, six credential shapes, both two-ended writes, a dedup key replayed against another owner’s Problem, sixteen malformed classes, against a real database and a real credential. No defect was found.

Two new files, one extended. Suites that already prove a category at a real boundary are cited rather than copied (D-193): secret rests on the sanitization boundary suite, the detector/policy/redactor units, the retry queue’s filesystem redaction proof, logging and export; retry rests on `idempotent-replay` and `server-down` and is untouched.

`tests/security/owner-boundary.security.integration.test.ts` reads the generated contract at runtime and asserts the owner-scoped operation set is exactly the twenty-six classified in the file (D-194) — an operation added without a decision about its boundary fails there. Twenty-two are attacked with another owner’s identifier and their refusals compared to each other, which says more than each being 404 alone; the other four are checked for the thing that can actually go wrong with them.

`tests/security/malformed-input.security.integration.test.ts` covers fifteen schema classes rather than 27 routes (D-195), because `openapi.test.ts` already pins route breadth literally. Each attack must leave the database byte-identical, answer in the shared envelope, echo nothing, and reach the log with none of it.

`tests/delete/physical-delete.integration.test.ts` gained a clean-marker proof (D-196) that does not depend on the secret detector, with a control marker in the surviving parent and neighbour so an over-broad delete cannot pass it.

Two behaviours were deliberately left alone (D-197): an unknown query parameter is still ignored, and the validation-before-auth lifecycle order is not promoted into an invariant. No manifest test was added (D-198).

Fifteen mutations were injected and every one is killed by a **named** target test, not merely by the suite going red somewhere: unsanitized transactional repository, confirmed secret kept, caller-written secret key accepted, `getProblem` unscoped, relation refusal unmapped, export owner predicate dropped, ownership checked after the dedup key, change logs surviving a delete, the incoming relation surviving, the delete unscoped, a retry inventing a key, event dedup removed, `removeAdditional`, `coerceTypes`, and a parse failure logged with its error.

Schema unchanged: migrations 13, tables 11, DOMAINs 8, FKs 12 all RESTRICT, 25 repository operations, 3 runtime dependencies, OpenAPI 0.4.0 with 27 operations, export schema "1", queue schema "2". 2561 tests across 85 files.

### P3-12 — DONE

Phase 3 E2E / Definition of Done.

**No production source changed.** One new file, `tests/e2e/phase3.e2e.test.ts`: fifteen explicitly-sequential steps carrying one secret-bearing investigation through everything Phase 3 built, on one owner, one credential, one Problem, one queue directory and one server lifecycle (D-199). Real socket, real connection failure, real filesystem queue, production logger configuration; the retry runs at the persisted `nextAttemptAt`, never after a sleep.

Two secret Events, because the queue redacts before its disk and therefore before any delivery — an outage write can never present a raw secret to the server (D-200). Event A attacks the running server raw and proves server-side sanitization; Event B carries a second secret through the outage and proves the queue’s boundary, restart persistence, and exactly-once recovery under the key assigned before the failure.

"Deleted including search derivatives" is claimed in the form that is true before search exists (D-201): the aggregate is physically gone and the catalog holds no relation a derivative could live in — zero views, materialized views, foreign tables or partitioned tables beside the exact eleven tables. This corrects P3-11’s FK-inventory explanation: reference inventories do not prove store absence. The guard is expected to fail at P4-01/P4-09, and the change that fails it must extend the delete path, the delete tests and the guard together (D-202).

Eleven discrimination mutations each killed by a named step, including a real view planted in the schema and caught by name (D-203).

## PHASE 3 — COMPLETE

Definition of Done, mapped:
- server-side sanitization → P3-12 Event A + `secret-boundary.integration`
- credential separation → P3-12 whole-flow single credential, absent from queue/DB/export + `authentication.integration`
- retry/idempotency → P3-12 outage→recovery count 1 + `idempotent-replay.integration`
- failure fallback → P3-12 PENDING/continue/quiet sentinel + `fallback.test`
- physical delete → P3-12 same-target continuity + `physical-delete.integration` clean-marker proof
- export → P3-12 post-delete export with survivor + `memory-export` / `clean-restore`
- security E2E → P3-12 continuous flow + P3-11 five-category evidence

2576 tests across 86 files. Schema and contracts unchanged since P3-04: API 0.4.0 / 27 operations, export "1", queue "2", migrations 13, tables 11, DOMAINs 8, FKs 12 all RESTRICT, repository 25, runtime dependencies 3.

## DONE — Implementation Phase 4

### P4-01 — DONE

RetrievalArtifact. The first derived persistent store, and storage only.

`public.retrieval_artifacts` is the twelfth table: primary key `(owner_id, problem_id)`, a composite RESTRICT foreign key naming both columns against `problems`, and the first extension this schema requires — `vector`. One current artifact per Problem or none, no artifact id, no history, no version, because a regeneration replaces rather than adds and the whole store is rebuildable (D-209, D-210).

The embedding column is an untyped `vector`, not `real[]` and not `vector(1536)` (D-211). An array of floats has no distance operator and no path to one; a declared dimension would make the first model's dimension a schema fact before any model is chosen. Verified before writing the migration: 3- and 5-dimension rows coexist. The cost — no ANN index is possible — is accepted, since there is no search yet and the dimension can be fixed by the task that picks the model.

`source_fingerprint` is stored and compared for equality and computed nowhere here; `generated_at` is deliberately not a freshness test, because a slow generation timestamps an earlier state later. The upsert is unconditional and a test asserts an earlier `generated_at` is accepted. The gate belongs to P4-02 (D-212).

An artifact holding a confirmed credential is refused whole rather than redacted (D-213) — an embedding is computed before any redaction could apply, so a redacted row would still encode the secret in the half nobody can read. Excluded from the export, still exactly eight collections (D-214).

D-202 is fulfilled in this change set (D-215): the delete path, the physical-delete test, phase 3 E2E steps 11 and 12, and the exact catalog inventories (11 → 12 tables, 12 → 13 foreign keys) all moved together. Phase 3 stays COMPLETE.

Ten discrimination mutations each killed by a named test, one of them schema-level with a full `db:reset` around it.

2643 tests across 88 files. Migrations 14, tables 12, DOMAINs 8, FKs 13 all RESTRICT, runtime dependencies 3. API 0.4.0 / 27 operations, export "1", queue "2" — all unchanged, because P4-01 adds no HTTP surface.

### P4-02 — DONE

Retrieval summary generation. One Problem in, one draft out, nothing stored.

`RetrievalSummaryDraft` — normalized summary, keywords, structural features, source fingerprint — held in memory and returned (D-217). Nothing reaches `retrieval_artifacts`: an artifact is complete or absent, the embedding is P4-04's, and a zero vector, a placeholder model, a nullable-embedding migration and pulling the provider forward were all available and all refused. No `generated_at` either, since that names the moment complete content existed.

The source is read by one statement returning the finished document as text (D-218). Four reads would take four snapshots and could fingerprint a state that never existed; holding a transaction across the generation would keep a connection checked out for somebody else's inference. Built in SQL because it was measured — `jsonb` numbers come back through the driver as doubles, and `12345678901234567890` is the kind of build identifier that becomes `...567000`.

The document carries the Problem's semantic fields, the Environment snapshot, **all six Event types** and every Verification; it carries no identifier, timestamp, authorship, evidence reference or judgement field (D-219). `DISCOVERY` is load-bearing — concluding a Problem records the final cause as one — and `USER_CORRECTION` is what stops a superseded misunderstanding reading as current. Two Problems with the same content and everything else different produce byte-identical documents.

The fingerprint is SHA-256 over those exact bytes, prefixed `retrieval-source-v1` (D-220), so "what was this built from?" and "what did the generator see?" cannot drift apart.

`successful_directions` may be non-empty only for a Problem whose status requires a successful Verification and has one (D-221) — nothing links a `FIX` Event to a Verification, so the claim cannot be read out of storage, and the gate refuses rather than quietly emptying the list. `structural_features` v1 is eight exact keys with free-form labels and refusing bounds (D-222).

The generator is a vendor-free port (D-223) that is handed a string and cannot be handed a repository. `memory_read_enabled=false` blocks generation before the generator is called (D-224). The race is closed by reading again on three questions — still there, still readable, still the same digest — because a control toggled mid-generation leaves the digest unchanged (D-225). Generated output is inspected under the artifact policy before it can reach an embedding provider, with P4-01's check still standing behind it (D-226).

Fourteen discrimination mutations each killed by a named test.

2759 tests across 91 files. Nothing about the schema, the contract or the dependencies moved: migrations 14, tables 12, DOMAINs 8, FKs 13 all RESTRICT, `vector` installed, API 0.4.0 / 27 operations, export "1", queue "2", runtime dependencies 3, `MemoryRepository` 25 operations.

### P4-03 — DONE

Full-text search. Lexical candidate retrieval over stored artifacts.

It searches what exists and creates nothing (D-230), which means **in production it returns nothing today**: generation stops at a draft and a row needs an embedding. That is sequencing rather than a defect, and the shortcuts that would have hidden it — persisting the draft, a placeholder vector, pulling the provider forward — were each refused. Tests seed real artifacts through P4-01's repository.

The document is the artifact's `normalized_summary` and `keywords` and nothing else (D-231): not the Problem's own text, which would give the system a second definition of the searchable text and bypass P4-02's translation, and not `structural_features`, which P4-07 compares by meaning. Marker tests fix both exclusions.

`pg_catalog.simple`, named in full on both sides (D-232), because the server default is `english` and stems `Fastify` to `fastifi`. The cost — `deployment` no longer matches `deployed` — is measured and accepted; cross-word recall is the semantic half's job. Keywords weigh `A` and the summary `B` (D-233).

A generated stored column with a GIN index rather than an expression index (D-234): both use the index, but an expression index degrades *silently* when the query drifts — 218 ms against 0.1 ms on twenty thousand rows. `not null`, caught by the existing nullable-column inventory. No trigger; the database recomputes it, proven by a replace-and-research test.

The helper is genuinely immutable (D-235). `array_to_string` is STABLE, so the natural expression cannot be indexed, and the usual workaround is a false IMMUTABLE declaration — refused. The array is walked in plpgsql using only immutable primitives, and a test strips the function's comments to assert it.

`websearch_to_tsquery` (D-236); `to_tsquery` errors on ordinary prose. Terms are ANDed and that limitation is left visible rather than papered over. Owner and `memory_read_enabled` filter in SQL (D-237) — the read control matters here because the flag can be flipped after the artifact was written — while suppression, freshness, confidence and staleness do not filter at all. A query is ephemeral and never logged or stored (D-238). Japanese segmentation is a recorded limitation with a positive keyword-based mitigation and deliberately no negative test (D-239).

Fifteen discrimination mutations each killed by a named test.

2818 tests across 93 files. migrations 14 → **15**, public user-defined functions 0 → **1**, `retrieval_artifacts` columns 10 → **11**, plus one GIN index. Unchanged: tables 12, FKs 13 all RESTRICT, DOMAINs 8, enums/triggers/views 0, extensions 7, `MemoryRepository` 25, API 0.4.0 / 27 operations, export "1", queue "2", runtime dependencies 3.

### P4-04 — DONE

Embedding provider abstraction, and the full pipeline it unlocked.

`EmbeddingProvider` is a vendor-free port — modelId, modelVersion, required `dimensions`, `embed → unknown` — and the artifact records the model, never the provider, because two providers serving one model share a vector space (D-241). Output is validated to the declared dimension, all finite, not all zero; the zero rule is a measurement (stored zero vector ⇒ cosine distance NULL) and was promoted into `toEmbedding` itself so no storage path accepts one (D-242). The embedding input is `normalizedSummary` verbatim, which makes the model's input reproducible from the row it lands in (D-243).

`summary_generator_id` / `summary_generator_version` are now stored NOT NULL (migration 16), closing D-227: a summariser change leaves the fingerprint untouched, so provenance is the only way an old-summary artifact stays identifiable. The migration deleted the existing derived rows rather than inventing fake provenance; no Memory table was touched (D-244). `generated_at` is stamped by an injected clock when the complete content first exists — after embedding validation, before the gate — pinned by a call-order test (D-245).

The final gate is one short transaction under `FOR UPDATE` on the Problem row (D-246). Measured: Event/Verification appends, every Problem update, deletes and competing artifact upserts all block until the commit, so the re-read, the fingerprint check and the write are one act and concurrent generations serialise. External calls happen strictly before the transaction. The commit guarantees the fingerprint described the source *at that moment*; staleness afterwards is ordinary and belongs to revalidation (D-247). The flow is service-owned — no draft-accepting API — so only P4-02-inspected text can reach a provider, proven with the provider call count at zero for a refused draft (D-248).

End to end with scripted ports on the real database: generate → embed → gate → store → **find with the lexical search**. Not claimed: a deployed server generating artifacts by itself — there is no concrete generator, no concrete provider, and no caller (D-249).

Sixteen discrimination mutations each killed by a named test.

2872 tests across 95 files. Migrations 15 → **16**, `retrieval_artifacts` 11 → **13** columns. Unchanged: tables 12, FKs 13 all RESTRICT, DOMAINs 8, enums/triggers/views 0, user-defined functions 1, extensions 7, vector indexes 0, `MemoryRepository` 25, API 0.4.0 / 27 operations, export "1", queue "2", runtime dependencies 3.

### P4-05 — DONE

Vector search: semantic candidate retrieval, text in, nearest memories out.

The service embeds the query itself through P4-04's provider port — no raw-vector application API exists, so query-space compatibility is structural (D-250). A confirmed credential in the query is never transmitted: inspected before the embed call via a sanitization policy, answered with typed `SENSITIVE_QUERY_NOT_EMBEDDED` carrying nothing but its kind, provider and search both at zero calls. The lexical search's opposite rule (D-238) stands — the destination changed, not the principle (D-251).

Cosine (`<=>`) fixed as a system decision, pinned by the magnitude fixture; compatibility is model AND version AND `vector_dims`, all three, with incompatible rows excluded where they can neither error nor occupy the limit. Old-embedding-model artifacts are lexical-only, deliberately (D-252). Raw `cosineDistance`, lower-better, no threshold; one shared resolver with the lexical filters, semantic text bound 4000, lexical 1000 unmoved (D-253). Exact scan, no ANN index and no migration, on measured grounds — the untyped column cannot carry one and no model exists to type it; boundary tests hold migrations at 16 and vector indexes at 0 (D-254). A search writes nothing, proven across all nine tables.

Eighteen discrimination mutations each killed by a named test or guard.

2907 tests across 97 files. All counts unchanged: migrations 16, tables 12, FKs 13 all RESTRICT, DOMAINs 8, enums/triggers/views 0, user-defined functions 1, artifact columns 13, vector indexes 0, `MemoryRepository` 25, API 0.4.0 / 27 operations, export "1", queue "2", runtime dependencies 3.

### P4-06 — DONE

Hybrid candidate retrieval: both channels as one intent, fused by rank into a bounded list.

The request carries `lexicalText` and `semanticText` separately — different bounds, different questions — and this stage generates neither from the other, because deciding what a search is really asking is a policy that would sit here untested (D-256). Everything is validated before either channel runs, so a doomed request never reaches a provider (D-257).

The two channels must share an owner, compared once at construction: each is owner-safe alone and neither can see the other, so only the pairing can be wrong. The vector service gained one `readonly ownerId` derived from its reader (D-258).

Fusion is reciprocal rank fusion on ranks alone — the scores have opposite directions and incomparable scales, and normalising was measured to collapse. **k=10, not 60**: the published constant was calibrated for thousand-deep lists, and against a twenty-deep window it flattens rank 1 against rank 20 to 1.31 and lets a candidate placed last by both channels outrank one placed first by a channel. k=10 gives 2.73 and agreement wins to about rank 11 (D-259). Source depth is fixed at 20 whatever the caller's limit, which keeps a limit of 10 a true prefix of 20; the final limit is 10–20 because this is the stage a reranker narrows (D-260).

A null rank is not evidence against a Memory — it can be a superseded model or a window edge — so absence never penalises, and lexical-only candidates are first-class. Raw scores are dropped after ranking (D-261). Exactly one failure degrades: an unreachable provider. Malformed provider output, database errors and broken invariants are all raised rather than hidden behind a plausible result (D-262).

Twenty discrimination mutations each killed by a named test or guard.

2963 tests across 99 files. Every count unchanged: migrations 16, tables 12, FKs 13 all RESTRICT, DOMAINs 8, enums/triggers/views 0, user-defined functions 1, artifact columns 13, vector indexes 0, `MemoryRepository` 25, API 0.4.0 / 27 operations, export "1", queue "2", runtime dependencies 3.

### P4-07 — DONE

Structural reranking: ten-to-twenty candidates narrowed to one-to-five by whether they are the same kind of problem.

The v1 schema is confirmed as eight top-level keys, six of them free-form label lists — this repository's own notes had said "eight lists", and the sentence is corrected rather than the code (D-264). P4-02's parser is exported and reused for stored features; the success-claim gate stays at generation time, because it depends on status and Verifications a reader cannot see.

**Deterministic comparison was built and measured before it was rejected.** Exact label overlap, token Jaccard and character-bigram similarity all ranked *same technology, different cause* above *different technology, same structure*; with vocabulary varied, the cross-technology candidate scored 0.000/0.159 against the surface-similar one's 0.048/0.208. The acceptance condition is finding the same shape of problem in a different stack, and word overlap cannot see that (D-265). So this stage sits behind its own vendor-free port — not the embedding provider, and with no reranker identity, because nothing here is persisted (D-266).

The current profile is supplied by the caller and parsed rather than trusted; this stage reads no artifact of its own and writes nothing (D-267). Candidates are re-read in one statement with the owner and read control applied again, and deleted / artifact-missing / read-disabled / another owner's are one indistinguishable answer (D-268). One unreadable stored profile stops the whole comparison rather than dropping that candidate, because dropping it would be indistinguishable from judging it dissimilar (D-269).

The model sees two structural profiles and nothing else — no project, no fusion score, no ranks, no summary, no limit (D-270). Both inputs are re-inspected for credentials immediately before the call, and the policy is built inside the factory with no parameter to override it (D-271). The answer must cover every candidate exactly once, scored 0–1 with named evidence: allowing omissions would put a hidden threshold inside the model, and this stage has none on purpose (D-272). Structure decides, hybrid rank breaks ties, the limit is 1–5 defaulting to 5 (D-273). An unreachable reranker degrades with null scores; a malformed answer raises (D-274).

Two rules were added by review after the first commit. A claimed `matchedDimension` must have had content on both sides — availability, never agreement — so an empty `successful_directions` cannot be cited as evidence that two Problems are alike, which would turn an absence of record into a positive finding (D-276). And `hybridRank` is provenance rather than an index: when a candidate disappears between the stages the survivors keep their original positions, gap and all, because renumbering would rewrite the earlier stage's answer and hide the drop (D-277).

Forty-two discrimination mutations each killed by a named test or guard. Three survived a first run — two bounds asserted against themselves rather than their literal values, and an identity check masked by the newer availability check — and each time the test was fixed and re-run.

3081 tests across 101 files. Every count unchanged: migrations 16, tables 12, FKs 13 all RESTRICT, DOMAINs 8, enums/triggers/views 0, user-defined functions 1, artifact columns 13, vector indexes 0, `MemoryRepository` 25, API 0.4.0 / 27 operations, export "1", queue "2", runtime dependencies 3.

### P4-08 — DONE

Ranking policy: what order the surviving one-to-five candidates are offered in.

Deterministic code, no model. Every input is a stored control or a number that already exists, so the boundary putting semantic judgement behind a model and routine work in code falls between P4-07 and this — no port, no network, no vendor, and nothing crossing a process boundary to inspect (D-278).

"Same technology" is `Project.platform`, the one field claiming to name a Project's technology, compared case-insensitively and exactly. `React` matches `react`; `Node.js` does not match `node`. A missed match costs a tie-break; an invented one asserts a shared stack nobody claimed, and building a technology-identity model for a tie-break was refused (D-279). Null on either side is unknown, never different, and the four project relations are exclusive so proximity is never credited twice (D-280).

The order is a lexicographic tuple — not suppressed → currency → trust → structural score → proximity → hybrid position → identifier — with no weights and no threshold. A weighted sum was simulated first: the weights are invented, and a same-technology bonus of 0.86 reverses an order that 0.5 leaves alone (D-281).

**Structure outranks proximity, and the fixtures are why.** Every proximity-first arrangement let a same-technology candidate scoring 0.05 beat a cross-technology one scoring 0.95 — the acceptance condition for the whole system failing. The specification's search order is read as the order the search widens: it decides between equally trusted and equally similar candidates, and comes to the front whenever the rerank did not run (D-282). A missing structural score is skipped, never zeroed (D-283).

No importance, no status boost, no timestamp (D-284). Every ranking input is read from the database in one statement, because all of them are editable and two reads could compare a state that never existed (D-285). Nothing is removed for ranking low, and nothing is written (D-281, D-287).

One rule was corrected by review after the first commit. The comparator coalesced a missing structural score to zero — the exact conversion D-283 forbids — under a comment stating it did not. Unreachable through the service, and one direct call to an exported function away, so it now raises instead, and the guard reads the line rather than the prose above it (D-288).

Forty-three discrimination mutations each killed by a named test or guard. Eight survived a first run — six fixtures whose expected order coincided with the identifier tie-break, one rule tested only through inputs another rule already constrained, and one stale anchor — and each time the test was strengthened.

3184 tests across 103 files. Every count unchanged: migrations 16, tables 12, FKs 13 all RESTRICT, DOMAINs 8, enums/triggers/views 0, user-defined functions 1, artifact columns 13, vector indexes 0, `MemoryRepository` 25, API 0.4.0 / 27 operations, export "1", queue "2", runtime dependencies 3.

### P4-09 — DONE

Search cache: the three retrieval stages as one call, and a short-lived memory of searches already run.

The composition came first, because the specification's rule is about a whole search and there was no whole search — each stage had a factory and no caller (D-289). A caller names the Problem being worked on, the two texts, a structural profile, an optional filter and the two limits, and gets one of four outcomes.

**What is reused is the rerank result — the output of both expensive calls — and ranking runs on every search** (D-290). That is what keeps the cache safe rather than merely fast: suppressing a Memory, lowering its confidence, marking it invalid, relabelling its Project, switching its reading off or deleting it all take effect on the next search even when nothing was recomputed, because the stage that reads those never sees the cache.

Sameness is P4-02's canonical-source fingerprint, reused rather than reinvented: Events and Verifications count, controls do not. **`Problem.version` was measured and rejected — appending an Event or a Verification does not move it** (D-291). The key is a SHA-256 over a fixed-order JSON array with the owner inside it, and the search values are hashed and never kept, because a query may legitimately contain credential-shaped text and is safe only while it stays ephemeral (D-292). Nothing about the search is normalised except the limits, so an unstated limit and the default are one search.

Storage is a process-local `Map`, five minutes, a hundred entries, injected clock, no dependency, no schema — **D-202 does not fire because nothing is persisted**, and a disposable optimisation should not acquire a delete path to survive a restart it does not need (D-293). Reading refreshes recency and never extends the expiry.

The current Project is read from the Problem's own row as metadata beside the canonical document, so P4-02's fingerprint is untouched and a caller cannot name one Problem and another Project's neighbourhood (D-294). The Problem is read again after the two long calls, and a search whose question moved is reported rather than returned or kept (D-295). Only a clean search is cached; every degraded outcome is a statement about a moment (D-296). No single-flight and no hit/miss field, both recorded as deliberate (D-297).

Thirty-seven discrimination mutations each killed by a named test or guard. Four survived a first run — one mutation that changed no behaviour, three guards too loose to see the change — and each was fixed rather than accepted.

3272 tests across 105 files. Every count unchanged: migrations 16, tables 12, FKs 13 all RESTRICT, DOMAINs 8, enums/triggers/views 0, user-defined functions 1, artifact columns 13, vector indexes 0, `MemoryRepository` 25, API 0.4.0 / 27 operations, export "1", queue "2", runtime dependencies 3.

### P4-10 — DONE

Search usage logging: a completed search records that each Memory it surfaced was surfaced.

**One action, because a search observes one** (D-299). `SEARCHED` and nothing else. A candidate dropped by the hybrid or rerank stage is not `EXCLUDED` — that means considered and set aside, not narrowed out of a window — and returning a result is not `REFERENCED`. The four other actions stay with the explicit path an adapter uses when it actually sees them.

Rows are the final candidates only, one each; a search that surfaced nothing writes nothing, because a row needs a Memory to point at and inventing one would record a use that never happened (D-300). A degraded search that still surfaced Memories is recorded — cache eligibility and log eligibility are different questions (D-301). A reused search writes fresh rows from the ranking produced now, never from the cached rerank, so a Memory since deleted is not resurrected into an audit trail (D-302).

Who searched arrives as invocation context rather than in the request, and is deliberately **not** part of what makes a search the same search — so one assistant's result serves another while each is recorded under its own name (D-303).

The reason is composed by the server in one fixed shape from rank, Project relation, both channel statuses and comparison dimensions. No score, no trust controls, no identifiers, no technology label; `comparison_dimensions` is worded neutrally because the rerank guarantees content on both sides, not agreement (D-304). `result` is null.

A narrow writer with no field for a query or a profile, writing through the sanitized repository inside one transaction that wraps the rows and nothing else (D-305). Failure is best effort and never silent: a required reporter with no default receives a kind and a count (D-306). The cache is filled before the log, so a lost line cannot discard a reusable result (D-307).

One rule was corrected by review after the first commit. The reason decided whether to name comparison dimensions by looking at the list rather than at the rerank status — which agree only because the stage upstream happens to be wired correctly, and `composeSearchedReason` is exported. A direct call could produce a permanent row claiming structural evidence from a rerank that never ran, so the status is now load-bearing and the writer refuses the contradiction outright (D-309).

Twenty-nine discrimination mutations each killed by a named test or guard. Eight survived a first run — five stale anchors, two defence-in-depth checks each hidden by the other, one mutation that left the original call behind — and each was fixed rather than accepted.

3338 tests across 106 files. Every count unchanged: migrations 16, tables 12, FKs 13 all RESTRICT, DOMAINs 8, enums/triggers/views 0, user-defined functions 1, artifact columns 13, vector indexes 0, `MemoryRepository` 25, API 0.4.0 / 27 operations, export "1", queue "2", runtime dependencies 3.

### P4-11 — DONE

Current-environment revalidation contract: every Memory a search offers now carries what it was recorded under and what has to be re-established before acting on it.

**The server says what a Memory was true of, not whether it still is** (D-310). It has no working tree, no manifest, no running process and no way to read a vendor's documentation, so the request accepts no current environment, code, version or specification, the current Problem's own snapshot is not treated as "now", and there is no model and no network on this path.

The checklist is the specification's own four and **never shrinks** — not for a `CURRENT` freshness, `HIGH` confidence or a Memory from the current Project, because `CURRENT` is a statement about the record rather than the world and the specification says the confirmation is not skipped for a trusted or important Memory. The array is frozen at run time, since one array is shared by every candidate in the process (D-311).

The Environment is returned verbatim; extracting a runtime or a version list would mean guessing at a schema arbitrary JSON does not have, and an empty snapshot is ordinary (D-312). Evidence is Verifications including the ones that failed — a check that did not settle the matter is what stops it being repeated — with no cap, deterministic order, and `evidenceRef` returned as a reference that is never fetched (D-313).

One statement keeps three cases apart: a Memory that has gone is dropped indistinguishably, a readable Problem with no Environment is **raised** (the database refuses to create that state, and short results are ordinary enough to hide it), and a Problem with no Verifications returns an empty list (D-314). `rankingRank` renumbers to the position actually offered while `hybridRank` keeps its gaps (D-315). The envelope wraps the ranking view rather than widening it, leaving room for the two later tasks (D-316). Enrichment is fresh on every search and cached nowhere, because a Verification on a candidate moves nothing the cache key watches (D-317). A failed read raises rather than returning an empty context (D-318).

One rule was corrected by review after the first commit. Enrich renumbered survivors from their place in the input array without checking that each candidate's stated position matched it — true only because the ranking stage emits 1, 2, 3, and the service is exported. Reordered or gapped input would have been silently renumbered into something agreeing with neither (D-320).

Thirty-three discrimination mutations each killed by a named test or guard. Four survived a first run — two stale anchors, one fixture reusing a single identifier so the duplicate rule fired before the bound could, and one owner check covered by the others — and each was fixed rather than accepted.

3404 tests across 108 files. Every count unchanged: migrations 16, tables 12, FKs 13 all RESTRICT, DOMAINs 8, enums/triggers/views 0, user-defined functions 1, artifact columns 13, vector indexes 0, `MemoryRepository` 25, API 0.4.0 / 27 operations, export "1", queue "2", runtime dependencies 3.

### P4-12 — DONE

Dead-end handling: every Memory a search offers now also carries the directions already recorded as not leading anywhere.

**A warning, and never a prohibition** (D-321). No candidate is dropped for having dead ends, no order changes because of them, and the type carries nothing a caller could read as permission — no `retryBlocked`, `severity`, `approvalRequired` or `notify`. A direction that failed under one runtime or one library version may be right under another, and an environment difference is a legitimate reason to try again, which is what P4-11's historical Environment and its four checks are for; they arrive together and the caller decides. There is no post-ranking penalty either: `dead_end_directions` is already one of the seven dimensions the reranker weighs, and a second arithmetic penalty on how many Events exist would rank a Problem down for being honestly recorded.

The Event is the source, not the artifact's regenerable `dead_end_directions` — a generator's paraphrase, never reconciled with what it came from, and fine only for comparing structure (D-322). A later `USER_CORRECTION` does not cancel a dead end: nothing links the two, and inferring a retraction would mean reading free text and guessing (D-323). All of them come back, oldest first with an identifier tie-break, and identical text stays two records (D-324). Four fields and a time, with nulls preserved and nothing the candidate already names — no ids, no `clientEventId`, no `sourceAi` (D-325).

One statement keeps two cases apart: a Memory that has gone is dropped indistinguishably, and a Memory with nothing recorded gets an empty list, because "nowhere is known not to lead" must never be delivered in place of "this Memory is no longer available" (D-326). The final envelope moved out of the revalidation module into `src/domain/retrieval-result.ts`, so neither stage owns the answer and P4-13 attaches without either widening (D-327). Enrichment is fresh on every search and cached nowhere, since a `DEAD_END` on a candidate moves nothing the cache key watches; the cache is filled and the log written only after this stage succeeds (D-328). A failed read raises rather than being reported as nothing recorded (D-329).

Forty-one discrimination mutations each killed by a named test or guard. Six survived a first run: three were undetectable through behaviour and were re-aimed at the guard asserting the statement's text — a defence-in-depth owner predicate, a left join equivalent to an inner one here, and an `order by` the Map-keyed consumer does not depend on — all three kept, because the statement is exported and being deterministic on its own is worth having. The other three were real gaps and the tests were fixed. A seventh detector turned out to be a coin flip on random identifiers and was re-aimed at a fixture that contradicts the mutation by construction. A second round injected twenty-four forbidden constructs — derived profile as source, ranking penalties, current-environment request fields, a followed reference, filesystem and Relation reads, a cached or early-logged result, a new UsageLog action, writes, an HTTP surface, a migration. Two survived and both were real: the stage could have read `process.env` and compared the record against its own surroundings, and the envelope's field set was never pinned. Both guards were strengthened, no production behaviour changed, and sixty-five P4-12 mutations now hold (D-331). The P4-11 correction set was re-run and all five still hold.

3456 tests across 109 files. Every count unchanged: migrations 16, tables 12, FKs 13 all RESTRICT, DOMAINs 8, enums/triggers/views 0, user-defined functions 1, artifact columns 13, vector indexes 0, `MemoryRepository` 25, API 0.4.0 / 27 operations, export "1", queue "2", runtime dependencies 3.

### CLOSED — no contract returns successful-direction detail

Opened in P4-12, closed in P4-15. The question was whether the derived `successful_directions` reaching the structural comparison satisfied 「成功方向とdead-endの両方を利用できる」, or whether the final response needed historical detail of its own.

**It needed a field, and not the one that looked symmetric.** `FIX` Event detail is not returned, because a recorded fix is not a verified one and nothing links a fix to the Verification that later passed (D-352). What is returned is verification-gated derived guidance from the stored search profile, re-gated at read time (D-353, D-354).

### P4-13 — DONE

Conflict handling: every Memory a search offers now also carries what was recorded as disagreeing with it, and the material for working out which applies here.

**Material, never a verdict** (D-332). The specification says a conflict is not decided by majority: what gets compared is the difference in environment, in version, in symptoms, the stated reason, and the strength of the verification behind each, and if that cannot settle it the record stays `CONFLICTED` rather than being resolved. Every one of the five the server can supply and none is one it can judge, so there is no winner, no preferred Memory, no resolution, no score and no notification decision. A test performs all five comparisons against a single search result.

Two things called conflict are kept apart (D-333). `CONFLICTED` confidence is a statement about one record; a `CONTRADICTS` Relation is a link between two Problems. Neither implies the other, all four combinations occur and all four are distinguishable, and no derived marker restates what the confidence already says.

The candidate's own semantic side travels with the disagreements, because symptom difference is one of the five and the result did not previously carry the candidate's symptoms (D-334). The other Memory arrives as a snapshot rather than a search result — no rank, no score, and nothing recursive: one hop and stop (D-335). Only `CONTRADICTS` is read, and no relation is treated as settling another; a mistaken link is not withdrawn, because there is no update path and how one is corrected stays undecided (D-336). Direction decides which Problem to look up and then stops mattering; every link comes back, uncapped, unmerged and deterministically ordered (D-337).

One statement, because the answer is meant to be compared against itself — and because deleting a Problem removes its Relations in the same transaction, a link whose counterpart is gone cannot be observed within one snapshot (D-338). A disagreement never drops, demotes or reorders a candidate, and P4-08 is untouched: the specification asks for order adjustment for dead ends and asks for nothing of the kind here (D-339). Fresh on every search and cached nowhere, since a Relation between two candidates moves nothing the cache key watches; a read failure raises rather than reporting empty contradictions (D-340).

Eighty-one mutations each killed by a named test or guard — fifty-two on behaviour and twenty-nine injecting a forbidden construct, **both sets completed before the commit**. Five survived a first run: two unreachable through behaviour because the composite foreign key already makes a cross-owner link unstorable, re-aimed at the guard asserting the predicates textually while the predicates stayed; three real gaps in the tests, all strengthened. The P4-11 and P4-12 sets were re-run and all seventy still hold.

3526 tests across 110 files. Every count unchanged: migrations 16, tables 12, FKs 13 all RESTRICT, DOMAINs 8, enums/triggers/views 0, user-defined functions 1, artifact columns 13, vector indexes 0, `MemoryRepository` 25, API 0.4.0 / 27 operations, export "1", queue "2", runtime dependencies 3.

### P4-14 — DONE

Retrieval evaluation fixtures: a named corpus of nine scenarios, run against a real database through the whole pipeline, with a deliberate wrong answer in every one.

**It measures and changes nothing** (D-342). `git diff -- src` is empty, and so are the diffs against `package.json`, `supabase/` and the README. The rule was fixed in advance: a specification-grounded fixture that failed would have stopped the task as a finding rather than licensed an edit to production. Nothing needed it, and that rule is why the result means anything.

It proves that, given a working keyword signal, a working semantic signal and a structural judgement, the pipeline retrieves across Projects, fuses, reranks on structure, applies the ranking controls, enriches and bounds and reuses as specified. It proves **nothing** about a real embedding or reranking model, because there is no vendor, no network and no credential in it (D-343).

The fixture oracle reads the current and candidate structural profiles and nothing else — no identifier, no Project, no earlier rank (D-344). The cross-technology pair is paraphrased rather than copied, so a string-equality oracle would score it at zero, and a baseline test asserts that paraphrasing is real (D-345). Each channel is made load-bearing for exactly one scenario: the same-technology Memory is stored under an embedding model version the search never queries with, so only keyword search reaches it; the cross-technology Memory shares no vocabulary, so only the vector channel does (D-346). The seven controls candidates have structural strength running the exact reverse of their expected order, so no assertion can pass by luck, and the two cut by the ceiling are the best-controlled of the group (D-347).

Eighteen mutations, all caught by this suite. Two needed correcting first and both are findings (D-348): **the bound that applies to a search naming no limit is the default, not the ceiling**, and **self-exclusion is applied twice**, at the hybrid stage and again at the rerank stage, so removing either alone leaves the other holding. Both redundancies are deliberate and stay.

Constant observations are deliberately narrow (D-349): RRF `k = 10` NOT DISPROVEN with no alternative simulated; five offered candidates SUPPORTED as a functional bound with no claim of optimality; cache TTL and capacity INSUFFICIENT DATA with no new measurement taken; uncapped histories INSUFFICIENT DATA. No precision, recall, F1 or quality score — nine curated fixtures are named behaviour acceptance, not a benchmark, and no generated result file was committed.

3551 tests across 111 files. Every count unchanged: migrations 16, tables 12, FKs 13 all RESTRICT, DOMAINs 8, enums/triggers/views 0, user-defined functions 1, artifact columns 13, vector indexes 0, `MemoryRepository` 25, API 0.4.0 / 27 operations, export "1", queue "2", runtime dependencies 3 — and `HYBRID_RRF_K` 10, source depth 20, rerank default and ceiling 5, cache TTL 300000, capacity 100.

### P4-15 — DONE

Phase 4 end to end, and the successful-direction contract.

**A recorded fix is not a verified one** (D-352). Returning `FIX` Events as successful directions would have been the symmetric move and the wrong one: a `DEAD_END` Event is already the fact, while a `FIX` Event records only that a fix was tried, and nothing links it to the Verification that later passed. Three fixes and one passing check do not say which fix the check was about. This stage reads no Event at all.

What is returned instead is the summary generator's reading of the whole canonical history — derived guidance, plainly typed as `readonly string[]` so it cannot be mistaken for something recorded at a moment (D-353) — offered only while the record still passes the gate the generator was held to, re-applied at read time because an artifact is never rewritten when what it describes changes, and because the answer should not depend on a lifecycle rule enforced elsewhere (D-354). A Memory whose profile has not been generated is kept with an empty list; derived data does not decide whether experience exists (D-355). The stage sits between dead ends and conflicts, on both paths, and enters no cache (D-356).

Phase 4 ends with the retrieval surface still internal (D-357). The specification's minimum API does list a cross-project similarity search and that requirement is handed to P5-02 rather than cancelled — publishing a route now would ship a contract no standard composition can answer, and would settle how an assistant identifies itself by accident.

`tests/e2e/phase4.e2e.test.ts` carries one investigation from Project A to Project B in nineteen ordered steps, with the canonical history written over a real socket and the artifacts generated through the production service — the direct upsert P4-14 relied on is forbidden here (D-358). What P4-14 already proved at corpus level is cited rather than re-proved (D-359).

Fifty mutations, all killed by a named test or guard: thirty on behaviour, twenty injecting a forbidden construct, both sets completed before the commit. Two needed correcting first — a fixture whose dead-end warnings were already empty, and an Event guard that read only the statement. The P4-12, P4-13 and P4-14 sets were re-run and all hold.

3607 tests across 113 files. Every count unchanged: migrations 16, tables 12, FKs 13 all RESTRICT, DOMAINs 8, enums/triggers/views 0, user-defined functions 1, artifact columns 13, vector indexes 0, `MemoryRepository` 25, API 0.4.0 / 27 operations, export "1", queue "2", runtime dependencies 3 — and `HYBRID_RRF_K` 10, source depth 20, rerank default and ceiling 5, cache TTL 300000, capacity 100.

## PHASE 4 — COMPLETE

P4-01 through P4-15 are done. Retrieval is complete end to end: canonical Memory, a regenerable search rendering, hybrid candidate retrieval, structural reranking, deterministic ranking, and four kinds of material on every candidate — what it was true of, where it does not lead, where it did, and what contradicts it.

Not built, deliberately: no concrete embedding, summary or reranking provider; no HTTP route for search; no automatic trigger for generation or for searching. All four belong to Phase 5, and `docs/retrieval.md` says so publicly.

## PHASE 5 — IN PROGRESS

### P5-01 — DONE

Claude Code current official capability audit, and the connection decisions it produced.

Read-only throughout. Nothing was installed, configured or connected, no MCP server was added, no plugin, skill or hook was created, and nothing under the user's assistant configuration was touched. The audit read the official documentation, the published open skill format, and one large public reference skill library, then recorded what follows. No production code, test, migration, dependency, route or schema changed (D-377).

**The shape is frozen and the contract is not.** The ordinary interactive session is what gains a Memory rather than what gets wrapped (D-361); the connection is a user-scoped local stdio MCP adapter (D-362); the adapter sits on the common JSON API and may not import the core (D-363). Hooks carry lifecycle facts, Skills carry judgement, and a plugin is packaging decided later (D-366, D-369). Skill bodies are written to the portable open format so a second assistant reads the same file (D-367), and the reference library that proved cross-assistant skills work in practice is read for its shape rather than its vocabulary (D-368).

**Handed to later tasks by name.** Project identity has native signals and P5-03 decides what to do with them (D-364). A session identifies a conversation and never a Problem, and nothing assumes an identifier arrives with a tool call (D-365). Whether a session-start hook can reach the adapter depends on connection ordering the documentation does not state, so P5-04 measures it (D-375). The search route the specification requires is P5-02's and was not reduced (D-376).

**Two standing rules came out of it.** Check what the host already provides before building a mechanism (D-371), and use the lightest mechanism that is genuinely sufficient (D-372). Both apply to every Phase 5 task and neither is about this audit in particular.

Not depended on, deliberately: preview features, delegation as a transport, deferred tool loading as a precondition, and any programmatic wrapper of the interactive session (D-370, D-373, D-361). Not recorded, deliberately: the host version, the event catalogue, the command list, current flags, the reference library's contents, preview syntax, timeout defaults and configuration paths — all true today, none an invariant, all looked up fresh when needed (D-377).

Every count unchanged: 3607 tests across 113 files, migrations 16, tables 12, FKs 13 all RESTRICT, DOMAINs 8, `MemoryRepository` 25, API 0.4.0 / 27 operations, runtime dependencies 3.

### NEXT — P5-02 adapter boundary, common Memory API client, search transport

**NOT STARTED.** See the private Phase 5 breakdown. P5-01 settled how the assistant reaches the Memory; P5-02 settles what it says when it gets there — the adapter's tool surface, the common JSON API client, and the cross-project search route Phase 4 handed forward (D-357, D-376).

**Before the first real integration run, check that the local assistant installation is in a supported working state.** The audit found the launcher shim on this machine pointing at an executable that was not present, so the ordinary command did not start; the audit worked around it read-only rather than repairing it. Verifying and, where needed, automatically repairing or updating the installation is a preflight the tooling performs — a user should not be asked to fix it by hand. The repair itself has not been started, and the version number involved is not an invariant of this system (D-377).

## BLOCKED

None currently documented.

## SETTLED — local stack network exposure

Docker publishes the local Supabase ports on all interfaces, not only loopback. Enabling fewer services reduced the published ports to three, but the binding address is a Docker daemon setting, not a repository one.

Decided: not a blocker. The Docker daemon configuration is left unchanged, and the operating rule is to stop the local stack when it is not in use (`npm run supabase:stop`). Revisit only if the stack ever needs to run on an untrusted network.

## STANDING NOTE — the Verification insert is not transaction-safe

`appendEvent` deduplicates with `on conflict (owner_id, client_event_id) do nothing` and then re-reads. `appendVerification` lets the unique violation raise and catches it.

Measured during P3-08: a unique violation aborts the surrounding transaction, so every statement after it fails with `25P02` until the transaction ends. The Event form avoids that and has to, because the close path appends Events inside a transaction. The Verification form would break the same way.

Nothing calls `appendVerification` inside an explicit transaction today, and a queued replay is an ordinary HTTP append, so this is currently harmless and was deliberately not changed inside an idempotency task (D-168).

**If `appendVerification` is ever called inside an explicit transaction, change it to the `on conflict do nothing` form first.**

## STANDING RULE — a replay respects the Problem as it is now

A delivery implementation replaying a queued write must respect the Problem's state at the time of the replay, not at the time of the enqueue (D-160).

`memory_write_enabled` is stored and settable and is not enforced on an append; the spec treats it as a rule about whether an assistant should write rather than something the server refuses, and P3-07 did not change that. But an Event queued while writes were enabled and delivered after the owner turned them off is a write the owner asked not to happen, and a delivery that blindly resends is acting on a decision that has since been reversed. The same applies to a Problem that has been concluded or suppressed in the meantime.

This belongs to the adapters in Phase 5 and Phase 6, and to whatever P3-08 and P3-09 settle about how a caller learns what happened to a queued write.

## STANDING RULE — anything derived from Memory joins the delete path

A phase that adds a retrieval artifact, a search index, an embedding store or any cache derived from Memory content must extend the physical delete path and the Phase 3 delete end-to-end in the same change (D-141).

The same applies to export: a derived store that is regenerated needs no place in an artifact, but one holding anything that cannot be rebuilt from the eight Memory tables does, and that is a decision to make deliberately rather than discover during a restore.

Inside PostgreSQL this is partly self-enforcing: give the table a RESTRICT foreign key to `problems` like everything else, and a delete that forgets it fails rather than silently leaving rows. The literal foreign key inventory in `tests/db/integrity.integration.test.ts` fails first, which is the intended prompt to decide.

Outside PostgreSQL — a vector store, an external search index — nothing enforces it. That integration has to be written deliberately when the store is introduced, and this line exists so the question is asked rather than remembered.

**P4-01 met this rule and it stays in force.** `retrieval_artifacts` joined the delete path, the delete tests, the phase 3 boundary guard and the catalog inventories in one change set (D-215), and was deliberately left out of the export because it is rebuildable (D-214). The rule applies unchanged to the next derived store — including any that lives outside PostgreSQL, where nothing will fail first.

## LATER

P3-02 onward follow the private Phase 3 breakdown. Phases 4–9 follow the roadmap in the private specification repository. Do not begin a later phase before the current one's Definition of Done is satisfied unless the specification is deliberately revised.
