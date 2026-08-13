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

The five codes are `INVALID_REQUEST` (400), `UNAUTHENTICATED` (401),
`NOT_FOUND` (404), `VERSION_CONFLICT` (409) and `INTERNAL_ERROR` (500).
Messages are fixed text and carry no detail; the detail is in the server log,
under `request_id`.

## Owner scope, and what authentication is not

Everything under `/v1` is owner-scoped. `/health` and `/openapi.json` sit
outside it: whether the process is serving, and what shape the API has, are
not anyone's memory.

The owner is established server-side in the current MVP. There is no
client-supplied credential, and so the OpenAPI document declares no security
scheme. Publishing `BearerAuth` or an API key header would describe an
authentication method that does not exist and would have generated clients
sending a header nothing reads.

`owner_id` appears on resources because it is data. It is never something a
caller supplies and never grants access to anything. Neither does `changed_by`
or `source_ai`: both are descriptive fields recording who did something, and
whatever a caller writes there, the owner comes from the established request
context and exactly the same data is reachable.

A real client credential lifecycle belongs to the later AI-integration phase.
Nothing here anticipates its shape.

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

## Consuming the document

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
