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

## Not built yet

**No concrete provider.** The summary generator, the embedding provider and the
structural reranker are ports. No vendor SDK, no model, no credential and no
network call exists in the runtime dependencies, which are still `fastify`, `pg`
and `@fastify/swagger`.

**No HTTP surface.** The retrieval path is an internal application service. The
specification lists a cross-project similarity search among the minimum API, and
that remains true — the transport belongs with the phase that builds the client
which will call it, alongside the decision about how an assistant identifies
itself. Publishing a route now would ship a contract that no standard server
composition can yet answer, because nothing concrete is wired behind the three
ports.

**No automatic trigger.** When to search — a problem appearing, repeated
failures, a large change in understanding — is an adapter's decision, not the
search's.
