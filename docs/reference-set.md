# Reference set

External material worth not forgetting.

**Reference ≠ Decision ≠ Adoption.** Everything below is here so that an idea, a
comparable system or a place to start looking is not lost. None of it is a
specification, a roadmap entry, a requirement, an architectural authority, an
instruction to implement anything, or an approval to do so.

## Where this sits

The authority chain is unchanged, and this document is outside it:

1. the private specification
2. the private roadmap and task breakdown
3. `.ai/DECISIONS.md`
4. the code and its tests

A Decision may say the same thing as something recorded here. When it does, the
Decision is the authority and this document is a note about where a similar idea
was seen. The reverse never holds: "it is in the reference set" is not a reason
to build anything, and nothing here overrides a Decision.

## Promoting a reference into work

Six steps, in order, and none of them skippable:

1. A future task actually needs it. Not "this would be interesting" — a task
   whose stated goal cannot be met without it.
2. The relevant official information is looked up **fresh at that point**, not
   read back from here.
3. It is compared against this project's current principles, including the ones
   below.
4. Investigation, then a design freeze.
5. An explicit Decision is added.
6. It is implemented inside that task's scope, and nowhere else.

Blogs, Zenn articles, X posts, videos and cheat sheets are legitimate ways to
_find_ something. They are not the final basis for anything about security,
authentication, a protocol, a provider's capabilities or a product's current
behaviour. For those, the official source is checked fresh — the whole point of
step 2.

Captured/curated: **2026-08-17**. Nothing here is asserted as currently true.
Where a status says fresh verification is required, that is a precondition rather
than a caution.

## Status vocabulary

| Status             | Meaning                                                                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `REFLECTED`        | Part of the principle is already in a Decision. The Decision is the authority; this is a cross-reference.                                |
| `FUTURE_CANDIDATE` | Worth considering later. Not on the roadmap.                                                                                             |
| `REFERENCE_ONLY`   | A comparison or an idea. Not adopted.                                                                                                    |
| `DISCOVERY_ONLY`   | A way to reach the official source. Not itself an authority.                                                                             |
| `NOT_NOW`          | Deliberately not adopted in the current MVP or phase.                                                                                    |
| `UNPINNED`         | The concept was kept from a conversation but the original source has not been recovered. Not usable as a basis for anything until it is. |

## Source quality labels

| Label                      | Meaning                                                                      |
| -------------------------- | ---------------------------------------------------------------------------- |
| `OFFICIAL`                 | The vendor's or standard's own documentation.                                |
| `REFERENCE IMPLEMENTATION` | A published implementation, read as evidence rather than as a specification. |
| `SECONDARY ARTICLE`        | Somebody's write-up. Useful, not authoritative.                              |
| `SOCIAL/DISCOVERY`         | A post or a cheat sheet. An entry point only.                                |
| `UNPINNED`                 | No recovered source.                                                         |

Official and social material are deliberately not shown as equals.

---

## Family A — Claude Code native capabilities

**Source** — `OFFICIAL`. Anthropic's Claude Code documentation, the
`code.claude.com/docs/en/*` family: MCP, hooks, settings, skills, plugins,
memory, the CLI reference, headless operation and channels. Verified fresh during
P5-01 on 2026-08-17.

**What we retained.** Principles only. The P5-01 audit is recorded in
`.ai/DECISIONS.md` and is not duplicated here — and deliberately did not pin
versions, event catalogues, command lists, flags or on-disk paths, because those
are true today and are not invariants (D-377).

| Principle                                                                                                | Status                                                                                                                        |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Check whether the host already provides a mechanism before building one                                  | `REFLECTED` — D-371                                                                                                           |
| A user-scoped local stdio MCP server is a light enough boundary to reach a running session               | `REFLECTED` — D-362                                                                                                           |
| Hooks carry deterministic lifecycle facts; Skills carry judgement                                        | `REFLECTED` — D-366                                                                                                           |
| A plugin is packaging convenience, not architecture                                                      | `REFLECTED` — D-369                                                                                                           |
| Deferred tool loading and server instructions make discovery resource-aware — welcome, never depended on | `REFLECTED` — D-373                                                                                                           |
| Native project-root and directory-scope signals can serve project detection                              | `REFLECTED` — D-364                                                                                                           |
| The host's permission model and Memory's own controls are separate axes                                  | `REFERENCE_ONLY`, consistent with D-096 (controls are not authorisation) and D-363 (permission semantics stop at the adapter) |
| A user-local credential reaching the adapter as environment and travelling as an authorization header    | `REFLECTED` — D-374                                                                                                           |
| Programmatic and headless surfaces exist and the interactive session is still not something to wrap      | `REFLECTED` — D-361                                                                                                           |

## Family B — Open agent skills, and Salesforce's library

**Sources**

- `OFFICIAL` — <https://agentskills.io/specification>
- `REFERENCE IMPLEMENTATION` — <https://github.com/forcedotcom/sf-skills>
- `SOCIAL/DISCOVERY` — <https://zenn.dev/denwaya/articles/salesforce-agent-skills-cheatsheet>
  (`DISCOVERY_ONLY`: how the two above were found)

**What we retained**

| Principle                                                                                      | Status                     |
| ---------------------------------------------------------------------------------------------- | -------------------------- |
| A portable Skill core, with host-specific metadata kept outside it                             | `REFLECTED` — D-367        |
| Semantic workflow separated from host-specific plumbing                                        | `REFLECTED` — D-366, D-367 |
| Progressive disclosure: a small body, detail fetched when needed                               | `REFLECTED` — D-368        |
| A Skill is not one enormous general-purpose instruction                                        | `REFLECTED` — D-368        |
| A published skill library is evidence that cross-assistant skills work, not a standard to copy | `REFLECTED` — D-368        |
| Do not build a registry or catalogue before there is a need for one                            | `FUTURE_CANDIDATE`         |
| Skill auto-generation and marketplace distribution                                             | `NOT_NOW`                  |

No Skill implementation begins from this document.

## Family C — Claude Code community articles

**Sources** — all `SECONDARY ARTICLE`.

- <https://zenn.dev/nozomi720/articles/claude_code_hooks_feedback>

  Retained: the idea of a feedback loop through hooks, whose output later becomes
  material for improving Memory, policy or a Skill. Explicitly _not_ the idea of
  storing raw hook payloads as Memory. Status: `FUTURE_CANDIDATE`.

- <https://zenn.dev/koki_n22/articles/986f61d16989cb>

  Retained: instruction surfaces — `CLAUDE.md`, Skills and their neighbours —
  need periodic review, or they overlap and grow. Status: `REFERENCE_ONLY`, as a
  future maintenance principle.

- <https://zenn.dev/satohjohn/articles/36c250162eb0ed>

  Retained: doubt that a language model is needed at all before reaching for one.
  Status: `REFERENCE_ONLY`; the same principle already exists here as "the
  lightest sufficient mechanism wins" (D-372), and deterministic code is
  preferred where it suffices.

## Family D — Commands and social material

**Source** — `SOCIAL/DISCOVERY`.
<https://x.com/claudecode84/status/2088551057186288043>, together with Claude
Code command cheat sheets shared in conversation (`/init`, `/plan`, `/context`,
`/compact`, `/clear`, `/model`, `/btw`, `/rewind`, `/agents`, `/chrome` and
others).

**What we retained.** Commands are a useful reference for operator usability, and
the way a long instruction compresses into a reusable semantic workflow is a
useful comparison for how a Skill is written. Checking native capability first
applies here as it does everywhere (D-371).

**Status** — `DISCOVERY_ONLY` / `REFERENCE_ONLY`. A social post or a cheat sheet
is not an authority on an API or an architecture, and which commands and flags
actually exist is checked against the official documentation and the CLI at the
moment a task needs them.

## Family E — Cloudflare, and "company OS" as a comparison

**Sources**

- `SECONDARY ARTICLE` — <https://www.youtube.com/watch?v=Iz5v-biPmt4> (a
  walkthrough of Cloudflare's internal "OS" thinking)
- `SECONDARY ARTICLE` — <https://gigazine.net/news/20260810-cloudflare-kitesurf/>
  (Kitesurf)
- `SECONDARY ARTICLE` —
  <https://zenn.dev/rdlabo/articles/cloudflare-workers-after-rich-programming>
- `SOCIAL/DISCOVERY` — <https://zenn.dev/aws_japan/articles/2b62886aa8735e>
  (`DISCOVERY_ONLY`. Kept as a source; no principle is derived from it here,
  because its contents were not re-read for this document and guessing at them
  would be worse than leaving it as a pointer.)

**What we retained.** Context, Skills, a tool gateway, an approval engine, an
audit trail, blueprints and a model router are a useful _vocabulary_ for what a
company-wide agent platform is made of, and therefore a useful thing to compare
this project against — mostly to see what it is not.

From Kitesurf specifically: the idea of putting the executor a task needs where
the task needs it, rather than running one large always-on agent for everything.

The comparison's main output is a constraint rather than a feature: this Memory
stays a Memory. It does not become a company OS, a tool gateway, a global
approval engine or a model router, and the module boundary that says so is older
than these references. Alongside that: choose the lightest sufficient executor,
pick a browser or execution backend only when something needs one, think about
where the boundary between model judgement and deterministic code falls, and
account for what an execution costs.

**Status** — `REFERENCE_ONLY` / `FUTURE_CANDIDATE`. The roadmap does not change.

## Family F — Remote compute

**Source** — `UNPINNED`. A Google Colab MCP/CLI reference was discussed; the
original source has not been recovered, and no URL is guessed at here.

**What we retained.** Compute placement as a question: heavy compute does not
have to live on the local machine, and a remote backend can be an option later.
That is not an argument for building a compute router now — it is one part of
being deliberate about what an execution costs.

**Status** — `UNPINNED` + `FUTURE_CANDIDATE`. Not usable as a basis for anything
until the source is recovered and verified fresh.

## Family G — Local models

**Source** — `UNPINNED`. Discussed in conversation; no specific source pinned.

**What we retained.** A local model is a future option whose merits depend on
privacy, cost, latency and available resources — and "local" is no more
self-justifying than "uses a language model". The machine's own resource cost is
part of the judgement.

**Status** — `NOT_NOW`, `UNPINNED`. Not a current priority, and not raised to one
by being written down.

## Family H — Identity, delegation and least privilege

**Source** — `UNPINNED` for the external material specifically. The
on-behalf-of and delegated-identity discussions in conversation cannot be traced
to a pinned source, and none is invented here.

**What we retained**

| Principle                                                                                 | Status                                                                                                                                                             |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Identity is established from a trusted credential or context, never from a caller's claim | `REFLECTED` — D-085 (`source_ai` describes and never authorises) and D-425 (the search composition takes its owner from the authenticated context and resolves it) |
| Least privilege                                                                           | `REFERENCE_ONLY`, consistent with the module boundary                                                                                                              |
| On-behalf-of and delegated context are explicit boundaries when they exist                | `FUTURE_CANDIDATE`                                                                                                                                                 |
| External tool credentials are not collected in the Memory Server                          | `REFERENCE_ONLY` — the OS boundary addendum places shared credential management outside this module                                                                |
| A Memory credential and an external tool credential are separate things                   | `REFLECTED` — D-374                                                                                                                                                |
| Memory records its own history and is not a global audit or approval layer                | `REFLECTED` — D-081                                                                                                                                                |

---

## Cross-cutting principles

The through-lines of everything above. Each is short on purpose; the ones that
have become rules say which Decision made them so.

1. **Native capability check.** Look for the mechanism in the host before
   building it. A reimplementation has to be maintained against something that
   keeps moving. `REFLECTED` — D-371.
2. **Lightest sufficient executor.** Model reasoning, a tool call, a hook, a
   Skill, a script and a delegated agent differ by orders of magnitude in cost;
   use the lightest one that genuinely suffices. `REFLECTED` — D-372.
3. **Resource-aware execution.** What an execution costs — tokens, latency, the
   machine — is part of choosing it. `REFERENCE_ONLY`, partly reflected in D-372.
4. **Model judgement versus deterministic code.** Where a decision has no
   judgement in it, code is better; where it has judgement, code will guess.
   `REFLECTED` — D-366, D-372.
5. **Progressive disclosure.** A small body, with detail fetched when it is
   needed. `REFLECTED` — D-368.
6. **Search → compare → design → build.** Look at what exists, compare it
   against the principles here, design, then build. Never build first.
   `REFERENCE_ONLY` — the working method of every investigation task so far.
7. **The user's goal outranks the plumbing.** An adapter that owns the process
   costs the reason anyone would run it. `REFLECTED` — D-361.
8. **A portable core beats host-specific convenience.** The second assistant
   should receive the same thing, not a translation of it. `REFLECTED` — D-363,
   D-367, and the client package's no-server-imports rule (D-432).
9. **External tool credentials stay outside the Memory.** `REFERENCE_ONLY` — the
   OS boundary addendum's line; the Memory credential's own path is D-374, and
   D-081 is the same instinct applied to audit.
10. **A reference is not an adoption.** The reason this document exists in this
    form. `REFLECTED` — D-439.

## Not adopted

Currently not part of this system. "Currently" is the operative word: none of
these is banned forever, and any of them would need the full promotion rule
above — a task that needs it, fresh official verification, comparison, a design
freeze and an explicit Decision.

- Memory as a company-wide OS
- Memory as a model router
- Memory as a general tool gateway
- Memory as a global approval engine
- Memory as a store for external tools' credentials
- A Skill registry or marketplace, before anything needs one
- Automatic Skill generation in the MVP
- A heavy Agent SDK or headless wrapper around the interactive session
- A dependency on a local model
- A compute router
