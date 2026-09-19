# Owner Decision Log

[日本語](OWNER_DECISIONS.md) | English

AI Problem-Solving Memory is not intended to make an AI "remember everything."

The central design question has been:

> **What should Memory be authoritative about, and what should it refuse to decide?**

This document highlights the owner-level decisions that shaped that boundary.

---

## 1. Make the Problem — not the conversation — the shared unit

### Problem

Conversation history is a poor long-term unit for engineering continuity.

Across sessions or models:

- symptoms become buried in prose
- failed approaches are retried
- "fixed" language is mixed with actual verification
- similar past work is difficult to reuse

### Decision

The persistent unit is a **Problem identity**.

A Problem accumulates structured records such as Environment, HYPOTHESIS, ATTEMPT,
DEAD_END, DISCOVERY, FIX, and Verification.

Claude Code and Codex can therefore continue the same `problem_id` without exporting and replaying the full transcript.

**Evidence:** [Codex continues the same Problem](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/4c00d57a4082cb5abf8d74a35ae8d31f8cb22ca0)

---

## 2. Make server Problem state authoritative over model self-report

### Problem

An agent can say:

> "I am working on Problem X."

That statement may be stale, guessed, or based on the wrong project context.

A local binding can also have been correct earlier and wrong now.

### Decision

**Server state is authoritative.**

Local binding is an optimization hint and must be revalidated.

Project resolution follows the same principle:
if multiple candidates are plausible, the system does not silently pick one.
If current host location cannot be established safely, it fails closed instead of writing to an old project.

**Evidence:** [take current project location from the call](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/4817b8cd0eef5bc591e6c1fdcbff569563bd8415)

---

## 3. Separate FIX from Verification

### Problem

"Changed the code" and "proved the change works" are different facts.

If a FIX event itself proves success, then an agent can effectively create VERIFIED state by saying "fixed."

### Decision

**Verification is an independent entity.**

A FIX can exist without successful verification.
State transition rules check for actual successful Verification evidence before VERIFIED can be reached.

Failed verification is kept too.
A failed check is useful evidence for the next agent.

**Evidence:** [independent verification evidence](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/c21020b0d49ddd6586a3242fdd6461c3e8807cda)

---

## 4. Do not let a remote AI record a check it could not have run

### Problem

A remote host may not have grounded access to:

- the user's terminal
- local files
- the actual test runner

Allowing that host to record "tests passed" would make unexecuted verification look authoritative.

### Decision

Verification types that require unavailable execution are **rejected at the remote edge**.

A remote host does not get a weaker definition of evidence.

Human verification can still be recorded when the human actually confirms the result.

**Evidence:** [refuse checks remote sessions cannot have run](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/f862b67ab2b6e131d0f495f82085347458dcce07)

---

## 5. Keep recall explicit instead of making Memory an automatic oracle

### Problem

Automatically searching Memory on every problem looks convenient, but it hides a semantic decision:

> When should the current agent rely on past experience?

It also creates unnecessary provider calls and increases the chance of treating stale Memory as present truth.

### Decision

`recall_similar_experience` is an **explicit tool call**.

Memory returns evidence and candidates.
It does not decide that a past solution is currently correct.

Duplicate recall for the same Problem/request can be suppressed as a cache optimization,
but cache state is not authority.

**Evidence:** [add explicit recall tool](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/8e45544179448daf671538bf5f1e79a86049cdb3)

---

## 6. Keep core retrieval useful without a paid AI provider

### Problem

If semantic embeddings or an LLM reranker are mandatory:

- credentials become required for basic Memory use
- provider outage becomes core Memory outage
- canonical retrieval behavior depends on an external service

### Decision

**Tier 0 retrieval is deterministic and provider-free.**

Canonical Memory produces deterministic retrieval artifacts and lexical candidates.

Semantic retrieval and structural reranking are optional stages.
If those providers are absent or fail, only those stages degrade.

Strict lexical search may relax once after zero results; the system does not begin with fuzzy retrieval by default.

**Evidence:** [deterministic Tier 0 retrieval](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/c08824ead613b7b5d345f8d42de8c2dd87739ef9) / [relax only after zero results](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/7ba143a38702be7d9a21854215d6604a9588e385)

---

## 7. Do not let a Memory outage stop the user's real work

### Problem

Memory is an auxiliary system.

If Memory is temporarily unavailable, the user's coding or research task should not fail just because history could not be written immediately.

Silently dropping writes would be equally bad.

### Decision

**The main task continues; the Memory write goes to a durable client-side queue.**

The queue is not placed inside the same unavailable server failure domain.

The order is:

1. sanitize
2. persist to queue
3. attempt external send

Sending first and queueing only after failure leaves a loss window if the process exits between those steps.

**Evidence:** [client-side durable queue](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/98312cfa839c48b4c24310e11c6baab44db4e0e3) / [enqueue before send](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/73550ac0a5dd6f1c8cdea5786de5ae91ce4241c7)

---

## 8. Separate at-least-once transport from one logical Memory effect

### Problem

A network timeout can mean:

- the server stored the event
- the client never received the response

Retrying with a new identifier would create duplicate Memory rows.

### Decision

A logical write receives one `client_event_id`.

The same id is reused across:

- queue persistence
- retry
- uncertain response handling

Transport may happen more than once.
The logical Memory effect should happen once.

**Evidence:** [stable client_event_id across retry](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/73550ac0a5dd6f1c8cdea5786de5ae91ce4241c7)

---

## 9. Do not create a separate Memory per AI host

### Problem

A "Claude memory", "Codex memory", and "remote memory" would split one engineering problem across multiple sources of truth.

### Decision

Supported hosts share:

- one Memory core
- one Problem identity
- one tool contract

Host capabilities may differ, but **Problem truth does not fork by host**.

Remote access is another transport edge, not another Memory system.

**Evidence:** [Codex continues the same Problem](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/4c00d57a4082cb5abf8d74a35ae8d31f8cb22ca0) / [one MCP core for remote hosts](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/33f23eabb389dde8fb2c12f9deb04b7c9431d2ed)

---

## 10. Stop Problem Control from growing into an Agent Runtime

### Problem

Once multiple agents share Problem state, it is tempting to keep adding:

- agent scheduling
- automatic handoff
- task claiming
- workflow orchestration
- model selection

That would mix the record of the problem with the runtime executing the work.

### Decision

Memory owns:

- Problem identity
- state
- typed evidence
- Verification
- retrieval material
- consistency

It does **not** own the caller's main execution workflow.

A human can switch hosts and continue the same Problem without requiring Memory to become an autonomous agent orchestrator.

**Evidence:** [Memory does not run the caller's main work](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/56d6e2d5fb6caf62b3bffa792f6fd47110e95279)

---

## What this project prioritizes

AI Problem-Solving Memory prioritizes:

- Problem identity over transcript continuity
- server state over model self-report
- Verification over success language
- evidence the current host could actually observe
- explicit retrieval over hidden automatic judgement
- a provider-free core
- failure isolation from the user's main work
- retry-safe logical writes
- one Problem truth across hosts
- a strict boundary between Problem Control and Agent Runtime

The implementation uses AI assistance, but the important part of the repository is not code volume.

It is **where Memory is allowed to be authoritative — and where it deliberately is not**.
