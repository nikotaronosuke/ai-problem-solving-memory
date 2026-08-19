# API contract

The machine-readable contract is `GET /openapi.json`. This document explains
the parts of it that a schema cannot say.

There is no field reference here. Fields, types, enumerations and required
properties are in the OpenAPI document, which is generated from the schemas
the server actually enforces and therefore cannot be out of date. Repeating
them in prose would create a second description that can.

## Where the contract comes from

Every route declares a JSON Schema for its parameters, its request body and
each response it can return. Fastify validates incoming requests against those
schemas and serialises responses through them, so they are not documentation
that sits beside the implementation — they are the implementation.

`@fastify/swagger` reads the same schemas at startup and assembles an OpenAPI
3.1 document. `GET /openapi.json` serves the result. Nothing is written by
hand and no generated file is committed, because a checked-in copy would be a
second thing to update and would be wrong the first time someone forgot.

The direction is one-way: route schema → document. A change to what the server
accepts changes the document in the same commit, necessarily.

OpenAPI 3.1 rather than 3.0 because the runtime schemas are plain JSON Schema.
`type: ['string', 'null']`, an `enum` containing `null`, `enum: [true]` and
`minProperties` are all ordinary there, and 3.1 adopts JSON Schema wholesale.
Targeting 3.0 would have meant rewriting live validation into its `nullable`
dialect — letting a document format decide what the server accepts, which is
backwards.

A contract test suite reads the generated document and asserts the operation
inventory, the enumerations, the required fields and the closed-object rules
against literal expected values. A route schema loosened by accident fails
there rather than being published.

There is no UI. A rendered explorer is a separate deliverable with its own
dependencies and static assets, and nothing is needed to consume a JSON
document.

## Conventions

JSON is snake_case on the wire; internal records are camelCase and are never
serialised straight out, so an implementation detail cannot become the
contract by accident. Identifiers are UUIDs. Timestamps are ISO 8601.

Request bodies set `additionalProperties: false`. An unexpected field is a 400
rather than something quietly dropped — silent removal lets a client believe a
field was honoured when it was discarded. Types are not coerced: `"4"` is not
`4`.

Every failure shares one envelope, and a client branches on `error.code`:

```json
{ "error": { "code": "VERSION_CONFLICT", "message": "..." }, "request_id": "..." }
```

The six codes are `INVALID_REQUEST` (400), `UNAUTHENTICATED` (401),
`NOT_FOUND` (404), `VERSION_CONFLICT` (409), `EXPORT_BLOCKED` (409) and
`INTERNAL_ERROR` (500). The two 409s share a status and differ in what a caller
should do: re-read a problem, or remove a record that holds a credential.
Messages are fixed text and carry no detail; the detail is in the server log,
under `request_id`.

## Owner scope, and how a request proves it

Everything under `/v1` is owner-scoped and requires a credential. `/health`
and `/openapi.json` sit outside it: whether the process is serving, and what
shape the API has, are not anyone's memory, and a probe that needed a
credential could not answer during the failure it exists to report.

A request carries one header:

```
Authorization: Bearer mem_<lookup>.<secret>
```

The token is opaque and says nothing about who holds it. Its first half is a
public selector that finds one row; its second half is the secret, and only the
SHA-256 digest of that half is stored. The server compares digests in constant
time, so a valid selector with the wrong secret is refused exactly as a
selector that matches nothing. The token cannot be reconstructed from the
database, which is why a lost token is replaced rather than recovered.

The credential names a client, the client belongs to an owner, and the server
resolves both. A request never names either. That indirection is the point of
the phase: revoking one client leaves the owner and every other client intact,
and an owner is a person's memory rather than a login.

Every request is verified against the database. Nothing about a credential is
held between requests, so revocation takes effect on the next call rather than
at the next restart.

Credentials are issued and revoked by local commands — `npm run
credential:issue -- --label "…"` and `npm run credential:revoke --
--credential-id …`. There is deliberately no HTTP endpoint for either. An API
that can mint its own credentials has to decide what may mint them, and that
decision belongs to whoever administers the machine rather than to a request.
Revocation takes a credential id rather than a token, so revoking one does not
put it in shell history.

Authentication fails one way. Missing, malformed, unrecognised, wrong and
revoked are five different things to an operator reading a log and one
`UNAUTHENTICATED` with a byte-identical body to a client — distinguishing them
would answer questions about credentials the caller does not hold.

`owner_id` appears on resources because it is data. It is not a credential:
presenting one authenticates nothing, and it is never something a caller
supplies. Neither is `changed_by` or `source_ai`: both are descriptive fields
recording who did something, and whatever a caller writes there, the owner
comes from the verified credential and exactly the same data is reachable.

An AI vendor account is not an owner identity and is never the ownership
boundary. A client is one place a credential was installed, not a person.

## Deleting is physical, and it is the only destructive thing here

`DELETE /v1/problems/{problem_id}?expected_version=N` removes a Problem
permanently. It is not the same operation as invalidating, suppressing, or
turning reads off — those three keep the record and say something about how to
use it. This one leaves nothing.

What goes with it: the Problem's events, verifications and change log, and
every relation and usage log that refers to it _from either direction_. A
relation another Problem recorded pointing at this one, and a usage log saying
another investigation drew on this one as memory, both name it and both carry
free text written while looking at it. So both are removed, and a surviving
Problem can lose part of its own history as a result. That is the intended
trade: a request to remove something outranks another record's account of it.

What stays: the Project and the Environment. An Environment is a moment in
time that other Problems may name, and a Project outlives the problems found
in it; neither is removed as a side effect, even when the deleted Problem was
the last one using it. Nothing else is touched — clients and credentials belong
to the owner rather than to any Problem.

Nothing is left behind to consult. There is no `deleted_at`, no `DELETED`
status and no tombstone, and no record is kept that a particular Problem once
existed. Afterwards every path answers 404: reading it, listing it, appending
an event or verification, relating to it, updating it, concluding it, reading
its change log. That is the same 404 a Problem that never existed gets, and the
same one another owner's gets.

`expected_version` is required, and it is worth knowing exactly what it
guarantees. It detects a change to the _Problem_ since it was read — an edit, a
status change, a conclusion. It does not detect an event or verification
appended in the meantime, because appending does not move the Problem's
version. A delete decided at version 5 can therefore remove an event that
arrived after the decision.

The request carries nothing else. No `changed_by`, because the change log for
this Problem is itself being deleted; no owner or client id, which come from
the credential; and no confirmation flag, because any client that can send the
request can send the flag too. **A caller acting on someone's behalf — an
adapter, a UI — must have that person's explicit intent before calling this.**
The server cannot check that, and a field claiming it would only record that
the client knew the field existed.

Success is `204` with no body: the Problem is deliberately not echoed back,
since a caller removing a mis-saved credential should not receive it one more
time. Deleting again is `404`. A stale version is `409`.

## Taking your memory with you

`GET /v1/export` returns everything belonging to the credential's owner as one
JSON document. No parameters: there is one thing to ask for here, and who is
asking is settled by the credential.

```json
{
  "schema_version": "2",
  "exported_at": "2026-08-14T07:37:29.381865Z",
  "source_owner_id": "…",
  "projects": [],
  "environments": [],
  "problems": [],
  "events": [],
  "verifications": [],
  "relations": [],
  "usage_logs": [],
  "change_logs": []
}
```

Every collection key is always present. An owner with nothing recorded gets
eight empty arrays rather than a shorter document, so a reader never has to
tell "nothing recorded" from "this export does not cover problems". Within each
collection, records are oldest first with the identifier breaking ties, so two
exports of the same data are the same bytes and a diff between two exports
means something.

Each record carries every column its table has, minus `owner_id`. That includes
fields the rest of the API treats as read-only — `version`, `client_event_id`,
the change log's version pair — because an export is not a view of the API. It
is the Memory, in a form you can keep.

### `source_owner_id`, and why it is not on every record

Ownership is a property of the export rather than of each record, so the owner
appears once at the top. It says which Memory this artifact came from.

It is **not a credential**: presenting it authenticates nothing. Nor is it
something a restore has to honour. An owner id is issued by this server and
means nothing anywhere else, so restoring into another install means giving the
records to whichever owner that install issued a credential for. Every _other_
identifier is preserved exactly — the relations, usage logs and change logs
refer to them, and remapping would mean rebuilding the whole reference graph.

### `schema_version` is not the API contract version

It describes the format of the document and moves when that format changes.
The API contract version describes the `/v1` surface and moves when a route
does. Sharing one number would tell whoever holds an artifact that its format
had changed because an unrelated endpoint was added, and the only safe response
to that is to re-read the whole file.

### What it does not contain

Nothing about clients or credentials: no token, no lookup, no digest, no client
identifier, no revocation state. A credential is how an owner reaches their
memory, not part of it, and an artifact carrying one would move access along
with the data — a backup file that is also a key.

Nothing belonging to anyone else, and nothing derived. There is no retrieval
artifact or search index yet; when there is, it is regenerated rather than
carried, and this document is the source it would be regenerated from.

### A memory holding a credential cannot be exported

If the Memory still contains a confirmed credential — written before the
sanitization boundary existed, or by a path that predates it — the response is
`409 EXPORT_BLOCKED` and no document is produced.

It is not redacted on the way out. An artifact that silently differs from the
database is no longer a copy of it, and restoring one would replace real
content with markers. It is not exported either: this is the largest single
egress in the system, into a file whose travels nobody tracks. So it is
refused, and the way forward is to delete the record that holds it — the same
`DELETE /v1/problems/{problem_id}` described above — and export again.

Only _confirmed_ credentials block. Something that merely looks suspicious —
an ambiguous field name with an ordinary word under it — exports normally,
because withholding somebody's own memory on a guess is a worse failure than
the guess occasionally being right.

The response says that something is there and nothing about where. Naming the
record would put a map to the credential in a response that travels wherever
the caller's logs do.

### Exporting changes nothing

Reading your own memory does not edit it. A refused export writes nothing back:
no redaction, no invalidation, no flag, no deletion. Exporting is also not a
precondition for deleting, and deleting does not export first.

### Precision

Timestamps carry microseconds, as PostgreSQL stores them —
`2026-08-14T07:37:29.381865Z`, not `…29.381Z`. Environment snapshots and change
log payloads are embedded as JSON with their numbers intact, including numbers
larger than a JavaScript integer can hold.

That is worth knowing if you process an artifact: `JSON.parse` followed by
`JSON.stringify` is **not** a round trip for this document. It rounds the
timestamps to milliseconds and large numbers to the nearest representable
value. Tools that need to preserve the file exactly should treat it as text.

One asymmetry follows from the same fact, in the other direction: a request
body is parsed before the server sees it, so a number too large for JavaScript
cannot be _stored_ through the API in the first place. The export preserves
what the database holds.

## Not found means one thing

A resource belonging to another owner answers exactly as one that does not
exist: 404, byte-identical envelope, no way to tell the two apart.

This is deliberate and is worth stating because it looks like missing
precision. A 403 for someone else's Problem would confirm the Problem exists,
which is the thing the 404 is protecting. The same applies to a malformed
identifier and to one that has never been issued. Anywhere a caller could
otherwise learn whether a resource exists — including by receiving a conflict
instead of a not-found — the not-found is answered first.

## Concurrency

Every write to a Problem carries `expected_version`, the version the caller
last read.

If the Problem is still at that version, the write happens and the version
moves by one. If not, nothing is written and the response is 409
`VERSION_CONFLICT`. The recovery is always the same: re-read the Problem,
decide again with what it now says, and resend with the new version. Retrying
the same request unchanged will conflict again.

The conflict names no version. A client that gets one already knows what it
sent, and reporting the current number would let someone probe a resource they
were refused.

All Problem write paths share that one version — the ordinary update, the
status transition, the memory controls and closing. Two of them racing produce
one success and one 409, never two silent successes. A lost update would
discard a finding without either party noticing, which is worse than an error
because it looks like it worked.

Appends do not participate. An Event or Verification can be recorded whatever
version the Problem is at, and recording one does not move it.

## Idempotency

Appending an Event or a Verification carries a `client_event_id`: a UUID the
caller mints before its first attempt and reuses if that attempt has to be
retried.

A retry returns what the first attempt wrote, with the same status and the
same body, so a client that never learned whether its request arrived can
simply send it again. First write wins: if the retry's payload differs, the
original stands. In particular a retry cannot change a recorded Verification
`result` — a retry is the same write arriving again, not a second check.

The key belongs to the owner rather than to a Problem. Sending a used key at a
different Problem replays the original rather than recording a second Event,
which is how a client discovers it reused one.

Closing has no `client_event_id` because it does not need one: the whole close
is protected by `expected_version`, so resending one that succeeded conflicts
rather than recording the review twice. The Events a close writes still carry
keys of their own, minted internally.

## Evidence

A Verification records that something actually checked whether the state
holds — a test run, a build, a real device, an API or database result, a
person confirming it. It attaches to the Problem, never to an Event: a `FIX`
Event says what was changed, a Verification says whether it worked.

`result` is a boolean and stays one. True means a check was carried out and
confirmed the state; false means it was carried out and did not. Neither means
"not checked yet" — that is the absence of a Verification. A string or a null
would let that third meaning in through the back door.

`VERIFIED` requires at least one Verification of the Problem's own whose
`result` is true. A `FIX` Event, a confident summary, a high confidence value,
a persuasive review and another Problem's evidence all count for nothing. This
is the rule the whole record exists to protect: an assistant saying "it works"
is not evidence that it does.

Recording a successful Verification does not move the Problem to `VERIFIED`.
Concluding is a separate, deliberate step.

## Memory semantics

**Status** moves only through the transition route or through closing, and
both apply the same matrix. `PAUSED` is resumable. `VERIFIED` and
`CLOSED_UNRESOLVED` are ends: reopening one raises questions about whether the
old evidence still holds, and nothing answers those yet.

**Closing** is the higher-level surface for ending a Problem, taking only the
three conclusions. It records where the Problem settles, optionally the
`fix_kind`, and optionally four review summaries, which become ordinary Events
rather than a resource of their own. It does not relax anything: the same
matrix, the same evidence gate, and a terminal Problem cannot be closed again.
Status, fix kind, review Events and one history entry commit together in a
single transaction and a single version step. `fix_kind` is writable here and
nowhere else in this phase.

**Relations** link two of your Problems with a stated meaning and a reason.
They may cross projects — a problem solved in one informing an investigation
in another is what makes this memory worth keeping — but never owners. A
relation is a link, not an inheritance: it carries no status, confidence,
freshness or evidence across, touches neither Problem, and moves no version.
Relating a Problem to a verified one does not let it become `VERIFIED`.

**Usage logs** record that past memory was actually drawn on, and by whom. A
`reason` is required, because without one the log is a hit counter and the
question worth answering later is whether the memory deserved to be used.
Logging is explicit: no read writes one, since a read that quietly writes can
fail for reasons the caller did not ask about and would claim a memory was
_used_ when all that happened was a look. This is Memory-specific history —
tool calls, deploys, model invocations and approvals are not recorded here.

**Change history** is written by the service, inside the same transaction as
the change it describes. There is no endpoint that creates one, and none that
edits or deletes one. Controlled values keep their before and after exactly;
free text is described rather than copied, because a title can hold something
that later has to be removed and a copy in the history would outlive the
removal. A refused change records nothing.

**Memory controls** decide how a Problem should be used as memory rather than
what it says. The axes are independent: turning off reads does not suppress,
suppressing does not invalidate, invalidating disables nothing. `invalidate`
accepts only `true` and sets `freshness` to `INVALID` — there is no inverse,
because restoring a guessed freshness would overwrite a real distinction.

They are not authorisation. Turning everything off leaves every read of your
own Problem working and the controls reachable, so nothing can be locked away
by accident. They are not enforced yet either: nothing retrieves memory
automatically, and nothing can distinguish your own write from an assistant's.
Recording the intent now is what lets the layer that can tell the difference
honour it later.

**Search** is the one operation whose answer is drawn from everything you have
rather than from the resource it names. It takes the Problem being worked on, two
query texts and a structural description of it, and returns candidates with the
material to judge them — what each was true of, where it did and did not lead,
and what contradicts it. Never a recommendation: the server's job is to put the
comparable material in front of whoever asked, and deciding what it means for
the situation in front of them is theirs.

Nothing about scope, ranking or cost is stateable by a caller. It searches every
Project you have, it excludes the Problem you are searching from, and the stage
bounds are the server's. Nothing about it is a write to the Problem, so there is
no `expected_version` and no conflict to report. It does record one usage log per
Memory it actually offered, which is the ordinary usage-log path rather than a
second kind of history — see `docs/retrieval.md` for the whole shape.

## Consuming the document

There is also a hand-written client — `@ai-problem-solving-memory/api-client` —
which speaks this contract for the two operations it has so far. It mirrors the
published value sets rather than importing anything from this repository, so it
can run beside a Memory Server it was not built with; tests here compare both
copies. It is not a generated client and there is no plan for one: a generator
would be a build step and a generated file to keep honest, which is larger than
what it replaces while the client has two methods.

`GET /openapi.json` needs no owner context and returns the document the server
generated at startup. It is the same object `app.swagger()` reports, and the
same on every request.

Every operation has a stable, unique `operationId` — `createProblem`,
`appendEvent`, `closeProblem`, and so on. These are the names a generated
client will use for its methods, so they are treated as part of the contract:
they are chosen to survive a path or method changing, and a rename is a
breaking change to anything generated from them.

The document itself is not listed in its own paths. It is one endpoint in one
format; there is no YAML variant, no owner-scoped copy and no UI.

`info.version` describes the `/v1` surface and moves when that surface changes
shape. It is deliberately not the package version, which would make every
unrelated release look like a contract change.
