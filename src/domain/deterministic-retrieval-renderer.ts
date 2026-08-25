/**
 * The deterministic retrieval renderer: a canonical source document in, a
 * generated summary out, and nothing else in the world consulted.
 *
 * ## Why it exists
 *
 * Retrieval must not require a paid model to exist. The searchable rendering
 * of a Problem — summary, keywords, structural features — can be derived from
 * the canonical source document alone, by rule, and a Problem whose owner has
 * no provider configured still deserves to be findable. This renderer is that
 * derivation: the Tier-0 generator the design draft names, producing the same
 * contract shape a model-backed generator produces, validated by the same
 * validator, gated by the same successful-direction rule.
 *
 * ## What kind of function this is
 *
 * Pure. No I/O, no environment, no clock, no randomness, and the input is
 * never mutated — the same document bytes always render to the same object.
 * That is not a style preference: the artifact this feeds carries a
 * fingerprint of exactly these bytes, and a renderer that consulted anything
 * else would produce output the fingerprint does not cover.
 *
 * ## What it selects, and what it refuses to invent
 *
 * A summary here is a selection, not a concatenation. The title, the
 * symptoms, the domain and boundary, what the investigation *found*
 * (`DISCOVERY`, which is also where a close records its final cause), what
 * fixed it (`FIX`, which is also where a close records the effective
 * direction), how it concluded, and what a successful Verification confirmed.
 * Dead ends appear as the shortest expression that still names the failed
 * direction. Hypotheses, attempts and user corrections are deliberately
 * absent from the summary text: they are the investigation's working noise,
 * already carried in full by the canonical record, and a retrieval document
 * that repeated all of them would bury the conclusions it exists to surface.
 *
 * Nothing is guessed. A document whose schema version this code does not
 * know, or whose enumerated values it does not recognise, is refused rather
 * than read approximately — an approximate reading of somebody's Memory is a
 * summary of a record that does not exist.
 *
 * ## Bounds, by construction
 *
 * The output validator refuses oversized output rather than trimming it, so
 * a renderer that must always succeed has to fit by construction: each
 * selected piece has a fixed budget, each list a fixed count, and the section
 * arithmetic below keeps the worst case inside `MAX_NORMALIZED_SUMMARY_LENGTH`.
 * Within a list the *latest* entries are kept, because a close writes its
 * review — the final cause, the effective direction — last.
 */

import {
  EVENT_TYPES,
  FIX_KINDS,
  PROBLEM_STATUSES,
  VERIFICATION_TYPES,
  type FixKind,
  type ProblemStatus,
} from './enums.js';
import { requiresSuccessfulVerification } from './problem-status.js';
import {
  RETRIEVAL_SOURCE_SCHEMA_VERSION,
  STRUCTURAL_FEATURE_SCHEMA_VERSION,
  MAX_KEYWORD_LENGTH,
  MAX_STRUCTURAL_FEATURE_ITEMS,
  MAX_STRUCTURAL_FEATURE_LENGTH,
  toGeneratedRetrievalSummary,
  type GeneratedRetrievalSummary,
  type StructuralFeatures,
} from './retrieval-summary.js';

/**
 * The renderer's identity, in the two fields P4-04 stores.
 *
 * `deterministic/v1` as a pair: the id names the kind of generator, the
 * version names this exact selection-and-budget rule. Any change to what is
 * selected, how it is clipped or how it is ordered moves the version, because
 * the version is the only thing that can tell reconciliation an artifact was
 * rendered by a superseded rule.
 */
export const DETERMINISTIC_RENDERER_ID = 'deterministic';
export const DETERMINISTIC_RENDERER_VERSION = 'v1';

/**
 * Raised when a document cannot be rendered.
 *
 * Names the part and the kind of problem, never a value: the document is
 * somebody's Memory, and this error travels into callers and logs.
 */
export class UnrenderableRetrievalSourceError extends Error {
  readonly part: string;

  constructor(part: string, reason: string) {
    super(`The canonical retrieval source ${part} is unrenderable: ${reason}.`);
    this.name = 'UnrenderableRetrievalSourceError';
    this.part = part;
  }
}

/**
 * The budget. The worst-case summary is the sum of every clipped piece, every
 * fixed label and every joining newline; a test holds that sum under the
 * domain maximum so the arithmetic cannot drift quietly.
 */
export const SUMMARY_BUDGET = {
  title: 240,
  symptoms: 480,
  domain: 240,
  boundary: 240,
  discoveries: { keep: 3, each: 280 },
  fixes: { keep: 2, each: 280 },
  deadEnds: { keep: 5, each: 120 },
  successfulVerifications: { keep: 2, each: 180 },
} as const;

interface SourceEvent {
  readonly eventType: (typeof EVENT_TYPES)[number];
  readonly summary: string;
}

interface SourceVerification {
  readonly verificationType: (typeof VERIFICATION_TYPES)[number];
  readonly result: boolean;
  readonly summary: string;
}

interface ParsedSource {
  readonly title: string;
  readonly symptoms: string;
  readonly problemDomain: string | null;
  readonly suspectedBoundary: string | null;
  readonly status: (typeof PROBLEM_STATUSES)[number];
  readonly fixKind: (typeof FIX_KINDS)[number] | null;
  readonly events: readonly SourceEvent[];
  readonly verifications: readonly SourceVerification[];
}

/** One spelling for any run of whitespace, so clipping is stable. */
function flattened(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Flattens, then fits. The ellipsis is the visible mark of the rule. */
function clipped(text: string, maximum: number): string {
  const flat = flattened(text);
  if (flat.length <= maximum) {
    return flat;
  }
  return `${flat.slice(0, maximum - 1)}…`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireText(value: unknown, part: string): string {
  if (typeof value !== 'string' || flattened(value) === '') {
    throw new UnrenderableRetrievalSourceError(part, 'it is not non-blank text');
  }
  return value;
}

function requireNullableText(value: unknown, part: string): string | null {
  if (value === null) {
    return null;
  }
  return requireText(value, part);
}

function requireMember<T extends string>(value: unknown, allowed: readonly T[], part: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new UnrenderableRetrievalSourceError(part, 'it is not a value this rule knows');
  }
  return value as T;
}

function parseSource(canonicalSource: string): ParsedSource {
  let document: unknown;
  try {
    document = JSON.parse(canonicalSource);
  } catch {
    throw new UnrenderableRetrievalSourceError('document', 'it is not JSON');
  }
  if (!isPlainObject(document)) {
    throw new UnrenderableRetrievalSourceError('document', 'it is not an object');
  }
  if (document['schema_version'] !== RETRIEVAL_SOURCE_SCHEMA_VERSION) {
    throw new UnrenderableRetrievalSourceError(
      'schema version',
      'it is not the version this rule renders',
    );
  }

  const problem = document['problem'];
  if (!isPlainObject(problem)) {
    throw new UnrenderableRetrievalSourceError('problem', 'it is not an object');
  }

  const rawEvents = document['events'];
  if (!Array.isArray(rawEvents)) {
    throw new UnrenderableRetrievalSourceError('events', 'it is not an array');
  }
  const events = rawEvents.map((entry, index): SourceEvent => {
    if (!isPlainObject(entry)) {
      throw new UnrenderableRetrievalSourceError(
        `event at ${String(index)}`,
        'it is not an object',
      );
    }
    return {
      eventType: requireMember(entry['event_type'], EVENT_TYPES, `event type at ${String(index)}`),
      summary: requireText(entry['summary'], `event summary at ${String(index)}`),
    };
  });

  const rawVerifications = document['verifications'];
  if (!Array.isArray(rawVerifications)) {
    throw new UnrenderableRetrievalSourceError('verifications', 'it is not an array');
  }
  const verifications = rawVerifications.map((entry, index): SourceVerification => {
    if (!isPlainObject(entry)) {
      throw new UnrenderableRetrievalSourceError(
        `verification at ${String(index)}`,
        'it is not an object',
      );
    }
    const result = entry['result'];
    if (typeof result !== 'boolean') {
      throw new UnrenderableRetrievalSourceError(
        `verification result at ${String(index)}`,
        'it is not a boolean',
      );
    }
    return {
      verificationType: requireMember(
        entry['verification_type'],
        VERIFICATION_TYPES,
        `verification type at ${String(index)}`,
      ),
      result,
      summary: requireText(entry['summary'], `verification summary at ${String(index)}`),
    };
  });

  return {
    title: requireText(problem['title'], 'title'),
    symptoms: requireText(problem['symptoms'], 'symptoms'),
    problemDomain: requireNullableText(problem['problem_domain'], 'problem domain'),
    suspectedBoundary: requireNullableText(problem['suspected_boundary'], 'suspected boundary'),
    status: requireMember(problem['status'], PROBLEM_STATUSES, 'status'),
    fixKind:
      problem['fix_kind'] === null
        ? null
        : requireMember(problem['fix_kind'], FIX_KINDS, 'fix kind'),
    events,
    verifications,
  };
}

/** The last `keep` entries, in their original order. Latest wins the budget. */
function latest<T>(entries: readonly T[], keep: number): readonly T[] {
  return entries.slice(Math.max(0, entries.length - keep));
}

/**
 * How each conclusion reads. Unquoted keys on purpose: the status vocabulary
 * is `domain/enums.ts`'s to name, and the architecture guard holds every other
 * module — this one included — to never spelling a status literal of its own.
 */
const CONCLUSION_LINES: Record<ProblemStatus, string> = {
  INVESTIGATING: 'Under investigation.',
  FIX_CANDIDATE: 'Has an unconfirmed fix candidate.',
  VERIFIED: 'Resolved.',
  PAUSED: 'Paused.',
  CLOSED_UNRESOLVED: 'Closed unresolved.',
};

const RESOLVED_FIX_KIND_LINES: Record<FixKind, string> = {
  ROOT_FIX: 'Resolved with a root fix.',
  WORKAROUND: 'Resolved with a workaround.',
};

/** How the Problem stands, said once and in the record's own vocabulary. */
function conclusionLine(source: ParsedSource): string {
  if (requiresSuccessfulVerification(source.status) && source.fixKind !== null) {
    return RESOLVED_FIX_KIND_LINES[source.fixKind];
  }
  return CONCLUSION_LINES[source.status];
}

/** `REAL_DEVICE` reads as `real device` in prose. Values were validated above. */
function verificationLabel(verificationType: string): string {
  return verificationType.toLowerCase().replace(/_/g, ' ');
}

function ofType(events: readonly SourceEvent[], eventType: SourceEvent['eventType']): string[] {
  return events.filter((event) => event.eventType === eventType).map((event) => event.summary);
}

/** Exact repeats add nothing to a search document. Order of first sight. */
function distinct(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const entry of entries) {
    if (!seen.has(entry)) {
      seen.add(entry);
      kept.push(entry);
    }
  }
  return kept;
}

/**
 * Whether this document supports claiming a successful direction: concluded
 * `VERIFIED`, and a successful Verification actually recorded. The same facts
 * the generation pipeline's own gate checks, read from the same document.
 */
function mayClaimSuccess(source: ParsedSource): boolean {
  return (
    requiresSuccessfulVerification(source.status) &&
    source.verifications.some((verification) => verification.result)
  );
}

function summaryOf(source: ParsedSource): string {
  const lines: string[] = [clipped(source.title, SUMMARY_BUDGET.title)];
  lines.push(`Symptoms: ${clipped(source.symptoms, SUMMARY_BUDGET.symptoms)}`);
  if (source.problemDomain !== null) {
    lines.push(`Domain: ${clipped(source.problemDomain, SUMMARY_BUDGET.domain)}`);
  }
  if (source.suspectedBoundary !== null) {
    lines.push(`Suspected boundary: ${clipped(source.suspectedBoundary, SUMMARY_BUDGET.boundary)}`);
  }
  lines.push(conclusionLine(source));

  const discoveries = SUMMARY_BUDGET.discoveries;
  for (const found of latest(distinct(ofType(source.events, 'DISCOVERY')), discoveries.keep)) {
    lines.push(`Found: ${clipped(found, discoveries.each)}`);
  }
  const fixes = SUMMARY_BUDGET.fixes;
  for (const fix of latest(distinct(ofType(source.events, 'FIX')), fixes.keep)) {
    lines.push(`Fix: ${clipped(fix, fixes.each)}`);
  }
  const deadEnds = SUMMARY_BUDGET.deadEnds;
  for (const deadEnd of latest(distinct(ofType(source.events, 'DEAD_END')), deadEnds.keep)) {
    lines.push(`Did not work: ${clipped(deadEnd, deadEnds.each)}`);
  }

  const successes = SUMMARY_BUDGET.successfulVerifications;
  const successful = distinct(
    source.verifications
      .filter((verification) => verification.result)
      .map(
        (verification) =>
          `${verificationLabel(verification.verificationType)}: ${clipped(
            verification.summary,
            successes.each,
          )}`,
      ),
  );
  for (const line of latest(successful, successes.keep)) {
    lines.push(`Verified by ${line}`);
  }

  return lines.join('\n');
}

/**
 * The deliberately-chosen terms: the domain, the boundary, and the title as
 * one phrase. Nothing is extracted from prose — term extraction is a
 * judgement this rule does not make.
 */
function keywordsOf(source: ParsedSource): readonly string[] {
  const candidates = [source.problemDomain, source.suspectedBoundary, source.title];
  return candidates
    .filter((candidate): candidate is string => candidate !== null)
    .map((candidate) => clipped(candidate, MAX_KEYWORD_LENGTH));
}

function structuralFeaturesOf(source: ParsedSource): StructuralFeatures {
  const label = (text: string): string => clipped(text, MAX_STRUCTURAL_FEATURE_LENGTH);
  const list = (entries: readonly string[]): readonly string[] =>
    latest(distinct(entries.map(label)), MAX_STRUCTURAL_FEATURE_ITEMS);

  return {
    schema_version: STRUCTURAL_FEATURE_SCHEMA_VERSION,
    problem_domain: source.problemDomain === null ? null : label(source.problemDomain),
    symptom_patterns: [label(source.symptoms)],
    suspected_boundaries:
      source.suspectedBoundary === null ? [] : [label(source.suspectedBoundary)],
    // Nothing in the canonical document states an occurrence condition or an
    // environment fact as such, and this rule does not infer them from prose.
    // Deliberately empty rather than approximately filled.
    occurrence_conditions: [],
    successful_directions: mayClaimSuccess(source) ? list(ofType(source.events, 'FIX')) : [],
    dead_end_directions: list(ofType(source.events, 'DEAD_END')),
    environment_facts: [],
  };
}

/**
 * Renders one canonical source document, deterministically.
 *
 * The result is passed through the same validator every generator's output
 * passes through, under the same successful-direction gate, so what this
 * returns is not merely shaped like a valid summary — it is one, by the one
 * definition the pipeline has.
 */
export function renderDeterministicRetrievalSummary(
  canonicalSource: string,
): GeneratedRetrievalSummary {
  const source = parseSource(canonicalSource);

  return toGeneratedRetrievalSummary(
    {
      normalizedSummary: summaryOf(source),
      keywords: keywordsOf(source),
      structuralFeatures: structuralFeaturesOf(source),
    },
    mayClaimSuccess(source),
  );
}
