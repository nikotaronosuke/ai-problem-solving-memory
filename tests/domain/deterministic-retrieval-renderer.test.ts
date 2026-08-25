/**
 * The deterministic renderer, held to what "deterministic" has to mean.
 *
 * Property-shaped rather than snapshot-shaped: the exact prose the renderer
 * writes may evolve with its version, but the invariants below are the
 * contract — same bytes in, same object out; the input never mutated; the
 * output valid under the pipeline's own validator; the success gate obeyed;
 * bounds held on adversarially long input; nothing invented that the document
 * does not contain.
 */

import { describe, expect, it } from 'vitest';

import {
  DETERMINISTIC_RENDERER_ID,
  DETERMINISTIC_RENDERER_VERSION,
  renderDeterministicRetrievalSummary,
  SUMMARY_BUDGET,
  UnrenderableRetrievalSourceError,
} from '../../src/domain/deterministic-retrieval-renderer.js';
import {
  MAX_KEYWORDS,
  MAX_KEYWORD_LENGTH,
  MAX_NORMALIZED_SUMMARY_LENGTH,
  MAX_STRUCTURAL_FEATURE_ITEMS,
  MAX_STRUCTURAL_FEATURE_LENGTH,
  toGeneratedRetrievalSummary,
} from '../../src/domain/retrieval-summary.js';

interface SourceOverrides {
  readonly problem?: Record<string, unknown>;
  readonly events?: readonly Record<string, unknown>[];
  readonly verifications?: readonly Record<string, unknown>[];
  readonly environment?: Record<string, unknown>;
}

/** A canonical source document, shaped exactly as the reader composes it. */
function documentOf(overrides: SourceOverrides = {}): string {
  return JSON.stringify({
    schema_version: '1',
    problem: {
      title: 'the nightly export writes an empty file',
      symptoms: 'the scheduled run completes without errors but the file has zero rows',
      problem_domain: 'batch exports',
      suspected_boundary: 'the query window against the job clock',
      status: 'INVESTIGATING',
      fix_kind: null,
      ...overrides.problem,
    },
    environment: overrides.environment ?? { runtime: 'node 22' },
    events: overrides.events ?? [],
    verifications: overrides.verifications ?? [],
  });
}

const event = (eventType: string, summary: string): Record<string, unknown> => ({
  event_type: eventType,
  summary,
  result: null,
  reason: null,
});

const verification = (result: boolean, summary: string): Record<string, unknown> => ({
  verification_type: 'TEST',
  result,
  summary,
});

/** A concluded, verified document with every selected element present. */
function verifiedDocument(): string {
  return documentOf({
    problem: { status: 'VERIFIED', fix_kind: 'ROOT_FIX' },
    events: [
      event('HYPOTHESIS', 'the query filters the wrong column'),
      event('ATTEMPT', 'rewrote the filter'),
      event('DEAD_END', 'rewriting the query filter'),
      event('DISCOVERY', 'the window is computed in the wrong zone'),
      event('FIX', 'compute the window in the configured zone'),
    ],
    verifications: [
      verification(false, 'first rerun still empty'),
      verification(true, 'rerun produces a full file'),
    ],
  });
}

describe('what the renderer is', () => {
  it('names itself deterministic/v1', () => {
    expect(DETERMINISTIC_RENDERER_ID).toBe('deterministic');
    expect(DETERMINISTIC_RENDERER_VERSION).toBe('v1');
  });

  it('is deterministic: the same bytes render to the same object', () => {
    const source = verifiedDocument();
    const first = renderDeterministicRetrievalSummary(source);
    const second = renderDeterministicRetrievalSummary(source);
    expect(second).toEqual(first);
    // And equality is structural all the way down, not reference luck.
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('does not mutate its input', () => {
    const source = verifiedDocument();
    const copy = source.slice();
    renderDeterministicRetrievalSummary(source);
    expect(source).toBe(copy);
  });

  it('always returns output the pipeline validator accepts', () => {
    for (const source of [documentOf(), verifiedDocument()]) {
      const rendered = renderDeterministicRetrievalSummary(source);
      expect(() =>
        toGeneratedRetrievalSummary(
          {
            normalizedSummary: rendered.normalizedSummary,
            keywords: rendered.keywords,
            structuralFeatures: rendered.structuralFeatures,
          },
          rendered.structuralFeatures.successful_directions.length > 0,
        ),
      ).not.toThrow();
    }
  });
});

describe('what the summary selects', () => {
  it('renders a minimal document from the problem fields alone', () => {
    const rendered = renderDeterministicRetrievalSummary(
      documentOf({ problem: { problem_domain: null, suspected_boundary: null } }),
    );
    expect(rendered.normalizedSummary).toContain('the nightly export writes an empty file');
    expect(rendered.normalizedSummary).toContain('Symptoms: ');
    expect(rendered.normalizedSummary).toContain('Under investigation.');
    expect(rendered.keywords).toEqual(['the nightly export writes an empty file']);
    expect(rendered.structuralFeatures.problem_domain).toBeNull();
    expect(rendered.structuralFeatures.suspected_boundaries).toEqual([]);
    expect(rendered.structuralFeatures.successful_directions).toEqual([]);
  });

  it('carries discoveries and fixes, and states the conclusion kind', () => {
    const rendered = renderDeterministicRetrievalSummary(verifiedDocument());
    expect(rendered.normalizedSummary).toContain('Found: the window is computed in the wrong zone');
    expect(rendered.normalizedSummary).toContain('Fix: compute the window in the configured zone');
    expect(rendered.normalizedSummary).toContain('Resolved with a root fix.');
  });

  it('distinguishes a workaround from a root fix', () => {
    const rendered = renderDeterministicRetrievalSummary(
      documentOf({
        problem: { status: 'VERIFIED', fix_kind: 'WORKAROUND' },
        events: [event('FIX', 'retry the export once')],
        verifications: [verification(true, 'the retried run is full')],
      }),
    );
    expect(rendered.normalizedSummary).toContain('Resolved with a workaround.');
  });

  it('keeps a dead end as the failed direction, minimally', () => {
    const rendered = renderDeterministicRetrievalSummary(verifiedDocument());
    expect(rendered.normalizedSummary).toContain('Did not work: rewriting the query filter');
    // The working noise stays out of the summary text.
    expect(rendered.normalizedSummary).not.toContain('the query filters the wrong column');
    expect(rendered.normalizedSummary).not.toContain('rewrote the filter');
  });

  it('summarises successful verifications and never failed ones', () => {
    const rendered = renderDeterministicRetrievalSummary(verifiedDocument());
    expect(rendered.normalizedSummary).toContain('Verified by test: rerun produces a full file');
    expect(rendered.normalizedSummary).not.toContain('first rerun still empty');
  });
});

describe('the successful-direction gate', () => {
  it('claims successful directions only for a verified problem with a successful verification', () => {
    const rendered = renderDeterministicRetrievalSummary(verifiedDocument());
    expect(rendered.structuralFeatures.successful_directions).toEqual([
      'compute the window in the configured zone',
    ]);
  });

  it('claims nothing for a fix that was never successfully verified', () => {
    const unverified = renderDeterministicRetrievalSummary(
      documentOf({
        problem: { status: 'FIX_CANDIDATE' },
        events: [event('FIX', 'compute the window in the configured zone')],
        verifications: [verification(false, 'still empty')],
      }),
    );
    expect(unverified.structuralFeatures.successful_directions).toEqual([]);
  });

  it('claims nothing for VERIFIED status without a successful verification in the document', () => {
    const rendered = renderDeterministicRetrievalSummary(
      documentOf({
        problem: { status: 'VERIFIED', fix_kind: 'ROOT_FIX' },
        events: [event('FIX', 'compute the window in the configured zone')],
        verifications: [verification(false, 'still empty')],
      }),
    );
    expect(rendered.structuralFeatures.successful_directions).toEqual([]);
  });

  it('still carries dead ends for an unconcluded problem', () => {
    const rendered = renderDeterministicRetrievalSummary(
      documentOf({ events: [event('DEAD_END', 'increasing the timeout')] }),
    );
    expect(rendered.structuralFeatures.dead_end_directions).toEqual(['increasing the timeout']);
  });
});

describe('bounds, on adversarial input', () => {
  const long = (seed: string): string => seed.repeat(400);

  function adversarialDocument(): string {
    return documentOf({
      problem: {
        title: long('title '),
        symptoms: long('symptom '),
        problem_domain: long('domain '),
        suspected_boundary: long('boundary '),
        status: 'VERIFIED',
        fix_kind: 'ROOT_FIX',
      },
      events: [
        ...Array.from({ length: 60 }, (_unused, index) =>
          event('DISCOVERY', `found#${String(index)} ${long('found ')}`),
        ),
        ...Array.from({ length: 60 }, (_unused, index) =>
          event('FIX', `fix#${String(index)} ${long('fix ')}`),
        ),
        ...Array.from({ length: 60 }, (_unused, index) =>
          event('DEAD_END', `dead#${String(index)} ${long('dead ')}`),
        ),
      ],
      verifications: Array.from({ length: 40 }, (_unused, index) =>
        verification(true, `${long('verified ')}${String(index)}`),
      ),
    });
  }

  it('never exceeds the summary, keyword and feature bounds', () => {
    const rendered = renderDeterministicRetrievalSummary(adversarialDocument());
    expect(rendered.normalizedSummary.length).toBeLessThanOrEqual(MAX_NORMALIZED_SUMMARY_LENGTH);
    expect(rendered.keywords.length).toBeLessThanOrEqual(MAX_KEYWORDS);
    for (const keyword of rendered.keywords) {
      expect(keyword.length).toBeLessThanOrEqual(MAX_KEYWORD_LENGTH);
    }
    for (const list of [
      rendered.structuralFeatures.symptom_patterns,
      rendered.structuralFeatures.suspected_boundaries,
      rendered.structuralFeatures.successful_directions,
      rendered.structuralFeatures.dead_end_directions,
    ]) {
      expect(list.length).toBeLessThanOrEqual(MAX_STRUCTURAL_FEATURE_ITEMS);
      for (const entry of list) {
        expect(entry.length).toBeLessThanOrEqual(MAX_STRUCTURAL_FEATURE_LENGTH);
      }
    }
  });

  it('keeps the latest entries when a list is over budget', () => {
    const rendered = renderDeterministicRetrievalSummary(adversarialDocument());
    // A close writes its review last, so the budget belongs to the tail.
    expect(rendered.normalizedSummary).toContain('found#59');
    expect(rendered.normalizedSummary).toContain('fix#59');
    expect(rendered.normalizedSummary).toContain('dead#59');
    expect(rendered.normalizedSummary).not.toContain('found#0 ');
    const summaryBudgetTotal =
      SUMMARY_BUDGET.discoveries.keep + SUMMARY_BUDGET.fixes.keep + SUMMARY_BUDGET.deadEnds.keep;
    const selectedLines = rendered.normalizedSummary
      .split('\n')
      .filter((line) =>
        ['Found: ', 'Fix: ', 'Did not work: '].some((label) => line.startsWith(label)),
      );
    expect(selectedLines).toHaveLength(summaryBudgetTotal);
  });
});

describe('what the renderer refuses rather than guesses', () => {
  it('refuses a document that is not JSON, not an object, or another schema version', () => {
    for (const source of [
      'not json at all',
      JSON.stringify([1, 2, 3]),
      JSON.stringify({ schema_version: '2', problem: {}, events: [], verifications: [] }),
    ]) {
      expect(() => renderDeterministicRetrievalSummary(source)).toThrow(
        UnrenderableRetrievalSourceError,
      );
    }
  });

  it('refuses an event type or verification type this rule does not know', () => {
    expect(() =>
      renderDeterministicRetrievalSummary(
        documentOf({ events: [event('SPECULATION', 'a type nobody defined')] }),
      ),
    ).toThrow(UnrenderableRetrievalSourceError);
    expect(() =>
      renderDeterministicRetrievalSummary(
        documentOf({
          verifications: [{ verification_type: 'VIBES', result: true, summary: 'looked fine' }],
        }),
      ),
    ).toThrow(UnrenderableRetrievalSourceError);
  });

  it('refuses an unknown status or fix kind instead of describing it approximately', () => {
    expect(() =>
      renderDeterministicRetrievalSummary(documentOf({ problem: { status: 'DONE_ISH' } })),
    ).toThrow(UnrenderableRetrievalSourceError);
    expect(() =>
      renderDeterministicRetrievalSummary(
        documentOf({ problem: { status: 'VERIFIED', fix_kind: 'MIRACLE' } }),
      ),
    ).toThrow(UnrenderableRetrievalSourceError);
  });

  it('names the part but never the value when it refuses', () => {
    try {
      renderDeterministicRetrievalSummary(
        documentOf({ events: [event('SPECULATION', 'mem_notatoken_but_looks_private')] }),
      );
      expect.unreachable('the document should have been refused');
    } catch (error) {
      expect(error).toBeInstanceOf(UnrenderableRetrievalSourceError);
      expect((error as Error).message).not.toContain('SPECULATION');
      expect((error as Error).message).not.toContain('mem_');
    }
  });
});

describe('nothing is added that the document does not contain', () => {
  it('every summary payload comes from the document; only fixed labels are new', () => {
    const source = verifiedDocument();
    const flattenedSource = JSON.parse(source) as unknown;
    const sourceText = JSON.stringify(flattenedSource);
    const rendered = renderDeterministicRetrievalSummary(source);

    const labels = [
      'Symptoms: ',
      'Domain: ',
      'Suspected boundary: ',
      'Found: ',
      'Fix: ',
      'Did not work: ',
      'Verified by test: ',
      'Resolved with a root fix.',
    ];
    for (const line of rendered.normalizedSummary.split('\n')) {
      const label = labels.find((one) => line.startsWith(one));
      const payload = label === undefined ? line : line.slice(label.length);
      if (payload.length > 0 && !labels.includes(payload)) {
        expect(sourceText).toContain(payload);
      }
    }
  });

  it('introduces no credential-shaped or path-shaped text of its own', () => {
    const rendered = renderDeterministicRetrievalSummary(verifiedDocument());
    const everything = JSON.stringify(rendered);
    expect(everything).not.toMatch(/mem_|sk-|Bearer |[A-Z]:\\|\/home\/|\/Users\//);
  });
});
