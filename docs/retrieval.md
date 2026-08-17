# Retrieval

How a Memory written in one Project becomes a candidate while somebody is
working in another. This document explains the parts a schema cannot say; the
shapes themselves live in the code.

## Canonical Memory and its search rendering are separate

What a person records — Problems, Events, Verifications, Relations,
Environments — is the Memory. A `RetrievalArtifact` is a **rendering of one
Memory built for a search**: a normalised summary, keywords, a structural
profile and an embedding.

The separation is deliberate and load-bearing:

- The artifact is **regenerable**. Change the summary generator or the
  embedding model and every artifact can be rebuilt; nothing a person wrote is
  touched.
- The artifact is **not exported**. An export carries the eight canonical
  collections. A rendering tied to whichever model produced it is not somebody's
  memory of solving a problem.
- Generating one **writes nothing canonical**. The generation path reads the
  Problem, calls a generator and an embedding provider outside any transaction,
  then takes a row lock, re-reads the source, compares a fingerprint and writes
  the artifact — all in one short transaction. What the commit guarantees is
  exactly that at the moment the artifact was written, its fingerprint described
  the source.
- Generating one **sends Memory content to a configured external provider**.
  The canonical source document goes to a summary model, the resulting
  summary to an embedding model, and at search time structural features go to
  a comparison model. Requests are marked not-to-be-stored, carry no tools
  and attach no identifiers. Without a configured provider credential nothing
  is sent anywhere. The provider sits behind vendor-neutral seams and is
  replaceable — no vendor is a permanent part of this design, and changing
  one regenerates artifacts rather than touching any Memory.
- With a provider credential configured, **the standard server maintains
  artifacts automatically**. Every canonical write schedules a background
  regeneration for its Problem; a reconciliation sweep runs at startup and
  periodically, finding Problems whose artifact is missing, from an old
  source schema, or from an outdated generation stack — which is also how an
  existing database backfills itself and how the system recovers from a
  crash or a provider outage, with no manual step. Without the credential the
  server runs exactly as before: every record and read works, and no
  artifact is generated.
- A provider outage **never stops the Memory**. Canonical writes succeed,
  `/health` keeps answering from the database, and a failed generation
  leaves the artifact absent — never a stale fallback — until a later write
  or sweep regenerates it.
- A searchable artifact **describes the current record, or it does not exist**.
  Every write that changes what a summary is generated from — an Event, a
  Verification, a canonical Problem field, a status — removes the stored
  artifact in the same transaction that records the change. A stale rendering
  is never offered with a warning or a lower rank; the Problem is simply absent
  from artifact-backed results until a new rendering is generated. Renderings
  from an older source schema are likewise never read. Artifact staleness is a
  property of the derived rendering and is not the Memory's `freshness`, which
  is a judgement about the world that ranking reads live.

## The search, stage by stage

A search takes the Problem being worked on, some words, and the caller's own
structural understanding of it. It never takes the current environment, the
current code, a planned fix or a proposed direction — see _What the server does
not decide_ below.

1. **Source read.** The current Problem's canonical document, which is also what
   the cache key is built from.
2. **Two channels, in parallel.** Full-text search over the artifact's summary
   and keywords; vector search over the embedding. Vectors are only compared
   within one model and version — a distance across models is a number that
   means nothing.
3. **Rank fusion.** The two candidate lists are merged by reciprocal rank, so
   neither channel's score scale has to be reconciled with the other's.
4. **Structural reranking.** A handful of candidates are compared against the
   caller's profile on seven dimensions — problem domain, symptom patterns,
   suspected boundaries, occurrence conditions, successful directions, dead-end
   directions, environment facts — and cut to at most five. This is a port with
   no vendor behind it yet.
5. **Ranking.** A deterministic tuple over stored controls: not suppressed
   first, then currency, then trust, then structural similarity, then how close
   the Project is, then the earlier stage's position, then the identifier. No
   weights, no thresholds and no model.
6. **Enrichment**, in four passes, each adding one thing.

The result is up to five Memories, and none is a perfectly ordinary answer: a
search that finds nothing worth offering says so with an empty list rather than
an error. Showing about three of what does come back is a presentation decision
that belongs to whatever is calling.

### Why technology alone does not decide the order

"React" and "Fastify" are not structural descriptions. "A value decided before
the process starts" is, and it matches in both. Structural similarity is weighed
_before_ how close the Project is, so a Memory from a different technology that
shares the shape of the problem is offered ahead of one that shares only the
words. That is the acceptance condition the retrieval work exists to meet.

## What a candidate carries

**`ranking`** — why it is here and in this position: trust, currency,
suppression, how close the Project is, the structural score and which dimensions
agreed.

**`revalidation`** — the Environment the Memory was recorded under, every
Verification performed on it including the ones that failed, and four checks
that never vary: current code, current environment, relevant version, official
specification. Attached unconditionally. A Memory the record calls current and
trusted still gets all four, because that is a statement about the record rather
than about the world.

**`deadEndWarnings`** — directions somebody recorded as not leading anywhere,
from the Events that recorded them, oldest first and uncapped. **A warning, never
a prohibition.** A direction that failed under one runtime or one library version
may be right under another, and nothing here says it may not be tried again.

**`successfulDirections`** — what the record supports saying worked. This one is
**derived guidance rather than recorded fact**, and the asymmetry with dead ends
is deliberate:

> A `DEAD_END` Event already _is_ the fact — somebody tried something and wrote
> down that it did not work. A `FIX` Event is not. A recorded fix is not a
> verified one, nothing links a fix to the Verification that later passed, and a
> Problem with three fixes and one successful check does not say which fix the
> check was about. Reporting all three would invent a causal claim; choosing
> among them by recency would invent a rule.

So these come from the summary generator's reading of the whole canonical
history, and are offered only while the Problem is verified _and_ has a
Verification that actually passed — the same gate the generator was held to when
it wrote them, applied again at read time so that the answer does not depend on
a rule enforced somewhere else. An artifact is never rewritten when what it
describes changes. An empty list means there is nothing that may currently be
offered as a direction that worked; it does not mean no fix was ever tried.

**`conflict`** — the Memory's own semantics, and every `CONTRADICTS` link
recorded against it, each with the other Memory's symptoms, conditions, trust,
currency and evidence. Enough to compare, and no verdict: the specification says
a conflict is not settled by majority, and which record applies depends on
conditions this process cannot see.

## What the server does not decide

It has no working tree, no package manifest, no running process and no way to
read a vendor's documentation. Everything that would settle "is this still
true?" lives where the work is happening. So:

- The request accepts nothing about the present — no current environment, code,
  version or specification.
- Nothing compares a Memory against the machine this server happens to run on.
- There is no winner between conflicting Memories, no preferred Memory, no
  resolution and no severity.
- There is no retry prohibition, and no notification decision.
- A `CONTRADICTS` link does not change either Problem's confidence, and a
  `CONFLICTED` Problem with no link recorded gets none invented.

The answer is material. Deciding what to do with it, and re-establishing what is
current, belongs to whatever is asking.

## Reuse

A repeated search for the same Problem in the same state of understanding reuses
the reranking result for five minutes, so the two expensive calls do not run
again. **Only that result is cached.** Every enrichment is read fresh on a reuse:
a Verification, a dead end, a status change or a contradiction recorded against a
_candidate_ moves nothing the cache key watches, so a remembered answer would go
stale with nothing to notice.

## Owner boundary

Every read applies the owner and the automatic-reading control again, at every
stage, at both ends of a link. A Memory that has been deleted, switched off, or
was never this owner's produces one indistinguishable answer: it is simply not
there. Searching cannot be used to ask whether an identifier exists.

## What a search writes

One `SEARCHED` usage log per Memory actually offered, and nothing else. Whether
anybody then read a Memory, took its direction or set it aside happens somewhere
this code cannot see, and is reported through the ordinary usage log path. The
log records the ranking view; it never copies a warning, a direction or a
disagreement into itself.

## How a search is asked for

`POST /v1/problems/{problem_id}/search`, with four fields: which assistant is
asking, the lexical query, the longer text to compare by meaning, and a
structural description of the Problem in front of the caller.

It hangs off the Problem being worked on because that Problem _is_ the search
context — the subject candidates are compared against, the source of the current
Project, and the one thing excluded from its own results. A collection route
would have to take the Problem in the body, which is the same fact with two
possible sources.

Four fields, and no fifth. Not an owner or a client, because ownership is
established by the credential and a request that could name an owner would be a
request that could name the wrong one. Not a Project, because a search is
cross-project by default and the current Project is read from the Problem's own
row. Not a limit of any kind, because how many candidates each stage considers is
the server's to tune and a published knob is a published promise. Not an
embedding or any vector, because a query vector must come from the space the
artifacts were embedded in, and the only way to guarantee that is for the server
to produce it. Not a model, a provider or a cache instruction, for the same
reason. Nothing unknown is dropped quietly: an unexpected field is a 400, so a
caller cannot believe a limit it sent was honoured.

Three of the four outcomes are `200`. A search that found nothing is one of
them — no candidates worth reading is a fact about the memory, not a fault. So
is a Problem whose owner turned automatic reading off, and a Problem that changed
underneath the search while it ran; both carry only their kind, because what to
do about either is the caller's decision. The fourth, a Problem this owner cannot
read, is the `404` every missing resource gets: unknown, deleted and somebody
else's are one answer here as everywhere.

Each channel reports itself by name. A server with no configured provider still
answers: the lexical channel works, the semantic channel reports
`PROVIDER_UNAVAILABLE`, the structural stage reports `RERANKER_UNAVAILABLE`, and
every candidate still carries its material with `structural_score` absent rather
than filled in with a zero. That is a smaller answer to the same question, not a
missing route — and it is why the route exists whether or not a credential does.

A channel that reports itself unavailable means the provider could not answer —
unreachable, timed out, rate limited, or a server error — and the smaller answer
is the right one. It does not mean the integration is broken. A provider that
answers with something the server cannot use, or refuses the request outright,
fails the search with a `500` instead, because an answer that looks complete is
worse than one that fails: nothing would ever prompt anyone to look. That failure
is never reported as a problem with the request, which had no part in it.

What a response never carries: a recommendation, a verdict, a winner, an answer,
a should-retry, whether anything was cached, or which model was involved. The
first group is the caller's judgement and the second is not a fact about the
memory that was asked for. A failure carries less still — the standard error
envelope and a request id, with nothing the provider said, in the response or in
the log.

## Not built yet

**No client method.** The server publishes the route; the common API client does
not call it yet. A search request has four fields and a three-branch answer, and
the client's default timeout is shorter than the deadline the provider calls sit
behind — so the method needs a timeout decision rather than a copy of an existing
one, and a half-written method is worse than none.

**No automatic trigger.** When to search — a problem appearing, repeated
failures, a large change in understanding — is an adapter's decision, not the
search's.
