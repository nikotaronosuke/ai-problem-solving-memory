/**
 * Where a refused Project field turns into refused input.
 *
 * Three layers have a stake in a malformed `repo_subpath` and each speaks its
 * own language. The domain says the value is not a boundary, by raising. The
 * transport says the caller sent something it will not accept, with a 400. The
 * application layer is the one that knows both, and translating there is what
 * keeps the transport from holding a reference to a domain error class.
 *
 * That is not a stylistic preference. If the edge maps the domain error, then
 * every new domain rule becomes a transport change, and the transport slowly
 * learns about layers it exists to be insulated from. The tests below pin the
 * translation where it belongs, and the architecture guard pins its absence at
 * the edge.
 *
 * The other half is what is *not* translated: a driver failure is not a
 * caller's mistake, and answering 400 for one would tell somebody their
 * request was wrong when the truth is that this service is.
 */

import { describe, expect, it } from 'vitest';

import {
  createProjectEnvironmentService,
  InvalidApplicationInputError,
  type AuthenticatedRequestContext,
} from '../../src/app/index.js';
import { InvalidProjectFieldError } from '../../src/domain/project.js';
import type { MemoryRepository } from '../../src/repository/index.js';

const PROJECT_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

/** Stands in for a boundary somebody should not find in an error. */
const PLANTED = 'home/someone-private/clients/acme';

/**
 * A context whose repository fails the way the layer beneath would.
 *
 * The real repository validates through the domain, so what a service sees for
 * a malformed field is exactly this error — raised from the write it asked for.
 */
function contextRaising(error: unknown): AuthenticatedRequestContext {
  const repository = {
    // Deliberately `unknown` rather than `Error`: one case below throws a
    // string, because "anything that is not the domain's refusal travels
    // untouched" has to include the values that are not Errors either.
    /* eslint-disable @typescript-eslint/prefer-promise-reject-errors */
    createProject: () => Promise.reject(error),
    updateProject: () => Promise.reject(error),
    /* eslint-enable @typescript-eslint/prefer-promise-reject-errors */
    getProject: () => Promise.resolve(undefined),
  } as unknown as MemoryRepository;

  return { repository } as AuthenticatedRequestContext;
}

const service = createProjectEnvironmentService();

describe('a Project field the domain refuses', () => {
  it('reaches a creating caller as refused input', async () => {
    const context = contextRaising(
      new InvalidProjectFieldError('repository boundary', 'it has a relative segment'),
    );

    await expect(
      service.createProject(context, { projectName: 'web', repoSubpath: '../escape' }),
    ).rejects.toBeInstanceOf(InvalidApplicationInputError);
  });

  it('reaches an updating caller as refused input', async () => {
    const context = contextRaising(
      new InvalidProjectFieldError('repository boundary', 'it has a relative segment'),
    );

    await expect(
      service.updateProject(context, PROJECT_ID, { repoSubpath: '../escape' }),
    ).rejects.toBeInstanceOf(InvalidApplicationInputError);
  });

  it('translates a refused name the same way, without inspecting which field it was', async () => {
    // The route schema catches a blank name first, so this path is reached by a
    // direct caller rather than by HTTP. Translating generically means a Project
    // rule added later needs no change here.
    const context = contextRaising(new InvalidProjectFieldError('name', 'it is blank'));

    await expect(service.createProject(context, { projectName: '   ' })).rejects.toBeInstanceOf(
      InvalidApplicationInputError,
    );
  });

  it('carries nothing of the original across', async () => {
    const context = contextRaising(
      new InvalidProjectFieldError('repository boundary', `it is not relative: ${PLANTED}`),
    );

    const raised = await service
      .createProject(context, { projectName: 'web', repoSubpath: `/${PLANTED}` })
      .catch((error: unknown) => error);

    // Boolean assertions throughout: a failing equality would print the very
    // value this is checking never travels.
    expect(raised).toBeInstanceOf(InvalidApplicationInputError);
    expect((raised as Error).message.includes(PLANTED)).toBe(false);
    expect((raised as Error).message.includes('someone-private')).toBe(false);
    expect(JSON.stringify(raised).includes(PLANTED)).toBe(false);
    expect((raised as { cause?: unknown }).cause).toBeUndefined();
  });
});

describe('a failure that is not the caller’s fault', () => {
  it.each([
    ['a driver failure', new Error('connection terminated unexpectedly')],
    ['a type error', new TypeError('cannot read properties of undefined')],
    ['a thrown string', 'something went wrong'],
  ])('propagates %s from a create unchanged', async (_name, thrown) => {
    const context = contextRaising(thrown);

    const raised = await service
      .createProject(context, { projectName: 'web' })
      .catch((error: unknown) => error);

    // Not translated, and identically the thing that was thrown. Turning this
    // into a 400 would report a broken service as a bad request.
    expect(raised).toBe(thrown);
    expect(raised).not.toBeInstanceOf(InvalidApplicationInputError);
  });

  it('propagates a driver failure from an update unchanged', async () => {
    const thrown = new Error('connection terminated unexpectedly');
    const context = contextRaising(thrown);

    const raised = await service
      .updateProject(context, PROJECT_ID, { repoSubpath: 'apps/web' })
      .catch((error: unknown) => error);

    expect(raised).toBe(thrown);
  });
});
