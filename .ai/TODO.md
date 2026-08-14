# TODO

Updated: 2026-08-13

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

Two findings came out of the work and neither was changed here. A request body is parsed by `JSON.parse` before the server sees it, so a number too large for JavaScript cannot be stored through the API at all — the export is lossless with respect to what the database holds, which is the strongest available claim. And `AWS_SECRET_ACCESS_KEY=…` is not detected: `accesskey` and `secretkey` are exact names in the P3-02 vocabulary rather than suffixes, so prefixed forms are unrecognised. That is a P3-02 detection gap, deliberately not fixed inside an export task.

Schema unchanged: migrations 13, tables 11, DOMAINs 8, FKs 12 all RESTRICT, 3 runtime dependencies. Repository operations 24 → 25, of which twelve are reads. API contract 0.3.0 → 0.4.0, operations 26 → 27. 2294 tests across 75 files.

### P3-07 — NEXT

Retry queue.

Depends on P3-06, satisfied. See the private Phase 3 breakdown for the completion condition.

A temporary queue for writes that fail to reach the Memory Server, distinguishing what should be retried from what should not, with basic backoff. `client_event_id` already exists on Events and Verifications and already deduplicates; P3-08 connects it to retry, so a queue that generated fresh keys on resend would defeat work that is already done. Nothing in P3-01 through P3-06 buffers a write — every path is synchronous and a failure reaches the caller — so this is the first component with state of its own.

## BLOCKED

None currently documented.

## SETTLED — local stack network exposure

Docker publishes the local Supabase ports on all interfaces, not only loopback. Enabling fewer services reduced the published ports to three, but the binding address is a Docker daemon setting, not a repository one.

Decided: not a blocker. The Docker daemon configuration is left unchanged, and the operating rule is to stop the local stack when it is not in use (`npm run supabase:stop`). Revisit only if the stack ever needs to run on an untrusted network.

## STANDING RULE — anything derived from Memory joins the delete path

A phase that adds a retrieval artifact, a search index, an embedding store or any cache derived from Memory content must extend the physical delete path and the Phase 3 delete end-to-end in the same change (D-141).

The same applies to export: a derived store that is regenerated needs no place in an artifact, but one holding anything that cannot be rebuilt from the eight Memory tables does, and that is a decision to make deliberately rather than discover during a restore.

Inside PostgreSQL this is partly self-enforcing: give the table a RESTRICT foreign key to `problems` like everything else, and a delete that forgets it fails rather than silently leaving rows. The literal foreign key inventory in `tests/db/integrity.integration.test.ts` fails first, which is the intended prompt to decide.

Outside PostgreSQL — a vector store, an external search index — nothing enforces it. That integration has to be written deliberately when the store is introduced, and this line exists so the question is asked rather than remembered.

## LATER

P3-02 onward follow the private Phase 3 breakdown. Phases 4–9 follow the roadmap in the private specification repository. Do not begin a later phase before the current one's Definition of Done is satisfied unless the specification is deliberately revised.
