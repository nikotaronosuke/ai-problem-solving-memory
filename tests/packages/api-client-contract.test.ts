/**
 * The client mirrors the contract; this is what keeps the mirror honest.
 *
 * `@ai-problem-solving-memory/api-client` cannot import the server — a client
 * that reached into this repository's `src/` would be a client only this
 * repository could run, which is the opposite of what it is for. So it carries
 * its own copies of the closed value sets and of the Problem's field list.
 *
 * A copy drifts. This file is where that is caught, and it lives in the
 * server's suite rather than the client's precisely because it is the only
 * side allowed to see both: the client stays neutral, and the copy still
 * cannot fall behind quietly.
 *
 * What fails here is a real thing rather than a bookkeeping mismatch. If the
 * server learns a sixth status and the client does not, the client rejects
 * every Problem in that state as a malformed response — a Memory that exists,
 * is readable, and is reported as a protocol failure.
 */

import { describe, expect, it } from 'vitest';

import {
  CONFIDENCES as CLIENT_CONFIDENCES,
  FIX_KINDS as CLIENT_FIX_KINDS,
  FRESHNESSES as CLIENT_FRESHNESSES,
  MEMORY_API_ERROR_CODES,
  MEMORY_SEARCH_CANDIDATE_FIELDS,
  MEMORY_SEARCH_COMPARISON_DIMENSIONS,
  MEMORY_SEARCH_MAX_LEXICAL_TEXT_LENGTH,
  MEMORY_SEARCH_MAX_SEMANTIC_TEXT_LENGTH,
  MEMORY_SEARCH_MAX_STRUCTURAL_FEATURE_ITEMS,
  MEMORY_SEARCH_MAX_STRUCTURAL_FEATURE_LENGTH,
  MEMORY_SEARCH_PROJECT_RELATIONS,
  MEMORY_SEARCH_REQUEST_FIELDS,
  MEMORY_SEARCH_REVALIDATION_CHECKS,
  MEMORY_SEARCH_SEMANTIC_STATUSES,
  MEMORY_SEARCH_STRUCTURAL_FEATURE_FIELDS,
  MEMORY_SEARCH_STRUCTURAL_FEATURE_LISTS,
  MEMORY_SEARCH_STRUCTURAL_FEATURE_SCHEMA_VERSION,
  MEMORY_SEARCH_STRUCTURAL_STATUSES,
  MEMORY_SEARCH_VERIFICATION_TYPES,
  ENVIRONMENT_RESOURCE_FIELDS,
  PROBLEM_RESOURCE_FIELDS,
  PROBLEM_STATUSES as CLIENT_PROBLEM_STATUSES,
  PROJECT_RESOURCE_FIELDS,
} from '@ai-problem-solving-memory/api-client';

import { SEMANTIC_CHANNEL_STATUSES } from '../../src/app/index.js';
import {
  CONFIDENCES,
  FIX_KINDS,
  FRESHNESSES,
  PROBLEM_STATUSES,
  VERIFICATION_TYPES,
} from '../../src/domain/enums.js';
import { PROJECT_RELATIONS } from '../../src/domain/retrieval-ranking.js';
import { REVALIDATION_CHECKS } from '../../src/domain/retrieval-revalidation.js';
import {
  MAX_SEARCH_TEXT_LENGTH,
  MAX_VECTOR_SEARCH_TEXT_LENGTH,
} from '../../src/domain/retrieval-search.js';
import {
  STRUCTURAL_COMPARISON_DIMENSIONS,
  STRUCTURAL_RERANK_STATUSES,
} from '../../src/domain/retrieval-structural-rerank.js';
import {
  MAX_STRUCTURAL_FEATURE_ITEMS,
  MAX_STRUCTURAL_FEATURE_LENGTH,
  STRUCTURAL_FEATURE_LISTS,
  STRUCTURAL_FEATURE_SCHEMA_VERSION,
} from '../../src/domain/retrieval-summary.js';
import { ERROR_CODES } from '../../src/http/errors.js';
import {
  ENVIRONMENT_RESOURCE_SCHEMA,
  PROBLEM_RESOURCE_SCHEMA,
  PROJECT_RESOURCE_SCHEMA,
} from '../../src/http/resources.js';
import { SEARCH_REQUEST_SCHEMA, SEARCH_RESPONSE_SCHEMA } from '../../src/http/search-resources.js';

describe('the value sets the client mirrors', () => {
  it('names the same Problem statuses as the domain', () => {
    expect([...CLIENT_PROBLEM_STATUSES]).toEqual([...PROBLEM_STATUSES]);
  });

  it('names the same fix kinds', () => {
    expect([...CLIENT_FIX_KINDS]).toEqual([...FIX_KINDS]);
  });

  it('names the same confidences', () => {
    expect([...CLIENT_CONFIDENCES]).toEqual([...CONFIDENCES]);
  });

  it('names the same freshnesses', () => {
    expect([...CLIENT_FRESHNESSES]).toEqual([...FRESHNESSES]);
  });

  it('names the same error codes as the one envelope', () => {
    expect([...MEMORY_API_ERROR_CODES].sort()).toEqual([...ERROR_CODES].sort());
  });
});

describe('the Problem the client expects', () => {
  it('requires exactly the fields the response schema requires', () => {
    // Taken from the schema the routes validate against, which is also what
    // the OpenAPI document is assembled from — so there is one source here,
    // and the client is compared to it rather than to a second list.
    expect([...PROBLEM_RESOURCE_FIELDS].sort()).toEqual(
      [...PROBLEM_RESOURCE_SCHEMA.required].sort(),
    );
  });

  it('expects no field the schema does not describe', () => {
    const described = Object.keys(PROBLEM_RESOURCE_SCHEMA.properties);

    for (const field of PROBLEM_RESOURCE_FIELDS) {
      expect(`${field}:${described.includes(field)}`).toBe(`${field}:true`);
    }
  });

  it('knows about every field the schema describes', () => {
    // The other direction, which the required-field comparison above does not
    // cover on its own: a property the server documents and the client has
    // never heard of would make the client's exact key check reject a Problem
    // the server considers ordinary.
    expect([...PROBLEM_RESOURCE_FIELDS].sort()).toEqual(
      Object.keys(PROBLEM_RESOURCE_SCHEMA.properties).sort(),
    );
    // Which is what entitles the client to check for an exact key set rather
    // than for the fields it needs: the server promised there would be no
    // others. The Project mirror has asserted this from the start; the Problem
    // one did not, and the client's Problem check was the looser for it.
    expect(PROBLEM_RESOURCE_SCHEMA.additionalProperties).toBe(false);
  });
});

describe('the Project the client expects', () => {
  it('requires exactly the fields the response schema requires', () => {
    // The same comparison the Problem gets, against the schema the routes
    // validate with — which is also what the OpenAPI document is assembled from,
    // so there is one source and the client is measured against it.
    expect([...PROJECT_RESOURCE_FIELDS].sort()).toEqual(
      [...PROJECT_RESOURCE_SCHEMA.required].sort(),
    );
  });

  it('expects no field the schema does not describe', () => {
    expect([...PROJECT_RESOURCE_FIELDS].sort()).toEqual(
      Object.keys(PROJECT_RESOURCE_SCHEMA.properties).sort(),
    );
    // Which is why the client checks for an exact key set rather than for the
    // fields it needs: the server promised there would be no others.
    expect(PROJECT_RESOURCE_SCHEMA.additionalProperties).toBe(false);
  });

  it('agrees a project carries the boundary its owner declared', () => {
    // The field the resolver tells two projects on one repository apart by. If
    // the client stopped expecting it, every project would read as malformed;
    // if the server stopped sending it, the same. One list, checked against
    // the schema the routes validate with.
    expect([...PROJECT_RESOURCE_FIELDS]).toContain('repo_subpath');
    expect(Object.keys(PROJECT_RESOURCE_SCHEMA.properties)).toContain('repo_subpath');
    expect([...PROJECT_RESOURCE_SCHEMA.required]).toContain('repo_subpath');

    const declared = PROJECT_RESOURCE_SCHEMA.properties.repo_subpath as {
      type: readonly string[];
    };
    expect([...declared.type].sort()).toEqual(['null', 'string']);
  });

  it('agrees that a repository and a platform may be absent', () => {
    // P5-03 compares Projects by repository, and a Project without one is
    // ordinary. A client that required it would reject those Projects as
    // malformed responses.
    for (const field of ['repo', 'platform'] as const) {
      const declared = PROJECT_RESOURCE_SCHEMA.properties[field] as { type: readonly string[] };
      expect([...declared.type].sort(), field).toEqual(['null', 'string']);
    }
  });
});

describe('the Environment the client expects', () => {
  it('requires exactly the fields the response schema requires', () => {
    expect([...ENVIRONMENT_RESOURCE_FIELDS].sort()).toEqual(
      [...ENVIRONMENT_RESOURCE_SCHEMA.required].sort(),
    );
  });

  it('knows about every field the schema describes, and no others', () => {
    expect([...ENVIRONMENT_RESOURCE_FIELDS].sort()).toEqual(
      Object.keys(ENVIRONMENT_RESOURCE_SCHEMA.properties).sort(),
    );
    // Which is what entitles the client to check for an exact key set.
    expect(ENVIRONMENT_RESOURCE_SCHEMA.additionalProperties).toBe(false);
  });

  it('agrees a snapshot is an object whose keys are the caller’s', () => {
    // The one deliberately open thing in this contract: which conditions
    // mattered differs by problem. Open about its keys, closed about being an
    // object — and the client refuses an array or a string for the same reason
    // the route does.
    const snapshot = ENVIRONMENT_RESOURCE_SCHEMA.properties.snapshot;
    expect(snapshot.type).toBe('object');
    expect(snapshot.additionalProperties).toBe(true);
  });
});

describe('the search vocabulary the client mirrors', () => {
  it('names the same semantic channel statuses', () => {
    // Not cosmetic: a status the client has never heard of makes it reject the
    // whole answer as malformed — a search that worked, reported as a protocol
    // failure, with the candidates thrown away.
    expect([...MEMORY_SEARCH_SEMANTIC_STATUSES]).toEqual([...SEMANTIC_CHANNEL_STATUSES]);
  });

  it('names the same structural stage statuses', () => {
    expect([...MEMORY_SEARCH_STRUCTURAL_STATUSES]).toEqual([...STRUCTURAL_RERANK_STATUSES]);
  });

  it('names the same project relations', () => {
    expect([...MEMORY_SEARCH_PROJECT_RELATIONS]).toEqual([...PROJECT_RELATIONS]);
  });

  it('names the same comparison dimensions', () => {
    expect([...MEMORY_SEARCH_COMPARISON_DIMENSIONS]).toEqual([...STRUCTURAL_COMPARISON_DIMENSIONS]);
  });

  it('names the same revalidation checks, in the same order', () => {
    // The order matters here in a way it does not elsewhere: the client returns
    // the list as it arrived, and a caller comparing it to its own copy would
    // find them equal only if both are the server's order.
    expect([...MEMORY_SEARCH_REVALIDATION_CHECKS]).toEqual([...REVALIDATION_CHECKS]);
  });

  it('names the same verification kinds', () => {
    expect([...MEMORY_SEARCH_VERIFICATION_TYPES]).toEqual([...VERIFICATION_TYPES]);
  });
});

describe('the search request the client builds', () => {
  it('speaks the structural feature vocabulary the server accepts', () => {
    expect(MEMORY_SEARCH_STRUCTURAL_FEATURE_SCHEMA_VERSION).toBe(STRUCTURAL_FEATURE_SCHEMA_VERSION);
    expect([...MEMORY_SEARCH_STRUCTURAL_FEATURE_LISTS]).toEqual([...STRUCTURAL_FEATURE_LISTS]);
  });

  it('holds the same bounds the server enforces', () => {
    // A client bound that is too loose sends a request the server refuses, for a
    // reason the caller cannot see. One that is too tight refuses a request the
    // server would have accepted. Both are silent until somebody hits them.
    expect(MEMORY_SEARCH_MAX_STRUCTURAL_FEATURE_ITEMS).toBe(MAX_STRUCTURAL_FEATURE_ITEMS);
    expect(MEMORY_SEARCH_MAX_STRUCTURAL_FEATURE_LENGTH).toBe(MAX_STRUCTURAL_FEATURE_LENGTH);
    expect(MEMORY_SEARCH_MAX_LEXICAL_TEXT_LENGTH).toBe(MAX_SEARCH_TEXT_LENGTH);
    expect(MEMORY_SEARCH_MAX_SEMANTIC_TEXT_LENGTH).toBe(MAX_VECTOR_SEARCH_TEXT_LENGTH);
  });

  it('sends exactly the fields the route accepts, and no others', () => {
    // Compared against the schema the route validates with, which is also what
    // the OpenAPI document is assembled from — one source, and the client
    // measured against it.
    expect([...MEMORY_SEARCH_REQUEST_FIELDS].sort()).toEqual(
      [...SEARCH_REQUEST_SCHEMA.required].sort(),
    );
    expect([...MEMORY_SEARCH_REQUEST_FIELDS].sort()).toEqual(
      Object.keys(SEARCH_REQUEST_SCHEMA.properties).sort(),
    );
    expect(SEARCH_REQUEST_SCHEMA.additionalProperties).toBe(false);
  });

  it('describes the current Problem with exactly the eight fields', () => {
    const features = SEARCH_REQUEST_SCHEMA.properties.current_features;

    expect([...MEMORY_SEARCH_STRUCTURAL_FEATURE_FIELDS].sort()).toEqual(
      [...features.required].sort(),
    );
    expect([...MEMORY_SEARCH_STRUCTURAL_FEATURE_FIELDS].sort()).toEqual(
      Object.keys(features.properties).sort(),
    );
  });
});

describe('the search answer the client expects', () => {
  /** The `SEARCHED` branch of the published `oneOf`. */
  const searched = SEARCH_RESPONSE_SCHEMA.oneOf[0];

  it('reads the same three kinds the server answers with', () => {
    const kinds = SEARCH_RESPONSE_SCHEMA.oneOf.map(
      (variant) => (variant.properties.kind.enum as readonly string[])[0],
    );

    // The client's own union is a type rather than a constant, so the check is
    // that the server publishes exactly these three — the fourth outcome a
    // caller sees is this client's naming of a 404 and is deliberately not here.
    expect(kinds).toEqual(['SEARCHED', 'MEMORY_READ_DISABLED', 'CURRENT_SOURCE_CHANGED']);
  });

  it('expects a candidate to carry exactly the five kinds of material', () => {
    const candidate = searched.properties.candidates.items;

    expect([...MEMORY_SEARCH_CANDIDATE_FIELDS].sort()).toEqual([...candidate.required].sort());
    expect([...MEMORY_SEARCH_CANDIDATE_FIELDS].sort()).toEqual(
      Object.keys(candidate.properties).sort(),
    );
    // Which is why the client checks for exact keys rather than for the ones it
    // needs: the server promised there would be no others.
    expect(candidate.additionalProperties).toBe(false);
  });

  it('reads the statuses from the same lists the response publishes', () => {
    expect(searched.properties.semantic_status.enum).toEqual([...MEMORY_SEARCH_SEMANTIC_STATUSES]);
    expect(searched.properties.structural_status.enum).toEqual([
      ...MEMORY_SEARCH_STRUCTURAL_STATUSES,
    ]);
  });
});
