# Owner Decision Log

[日本語](OWNER_DECISIONS.md) | English

These four decisions are the ones where implementation or real-host evidence materially changed the Memory boundary.

## 1. Separated FIX from Verification

An AI saying "I fixed it" is not the same as a test actually passing.

A FIX Event therefore cannot move a Problem to VERIFIED by itself. Verification is an independent entity, and failed Verification remains part of the record.

**Evidence:** [independent verification evidence](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/c21020b0d49ddd6586a3242fdd6461c3e8807cda)

## 2. Stopped resolving the current project from startup-time state

Real-host testing showed that a location captured at startup can become stale relative to the current call context.

Current project resolution was moved to per-call host context. Ambiguity fails closed, and old bindings are revalidated as hints rather than authority.

**Evidence:** [resolve project from current call context](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/4817b8cd0eef5bc591e6c1fdcbff569563bd8415)

## 3. Chose enqueue-before-send instead of send-first

A server can commit an event and then lose the response, leaving the client unsure whether the write happened.

With send-first, a process crash after that point creates a loss window.

The client therefore uses **sanitize → durable queue → send**, and retries reuse the same `client_event_id`.

**Evidence:** [durable retry queue](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/98312cfa839c48b4c24310e11c6baab44db4e0e3) / [enqueue before send](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/73550ac0a5dd6f1c8cdea5786de5ae91ce4241c7)

## 4. Did not create separate Memory systems for Claude and Codex

A real installed Codex host successfully continued a Problem started in Claude Code using the **same `problem_id`**.

The design keeps one Problem truth and one MCP core instead of per-host Memory silos.

**Evidence:** [Codex continues the same Problem](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/4c00d57a4082cb5abf8d74a35ae8d31f8cb22ca0)
