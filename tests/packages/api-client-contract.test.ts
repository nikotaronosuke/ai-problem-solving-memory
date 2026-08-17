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
  PROBLEM_RESOURCE_FIELDS,
  PROBLEM_STATUSES as CLIENT_PROBLEM_STATUSES,
} from '@ai-problem-solving-memory/api-client';

import { CONFIDENCES, FIX_KINDS, FRESHNESSES, PROBLEM_STATUSES } from '../../src/domain/enums.js';
import { ERROR_CODES } from '../../src/http/errors.js';
import { PROBLEM_RESOURCE_SCHEMA } from '../../src/http/resources.js';

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
});
