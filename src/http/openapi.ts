/**
 * The machine-readable contract.
 *
 * There is one description of this API and it is the schemas the routes
 * already declare — the ones Fastify validates requests against and serialises
 * responses through. This module does not restate them. It registers
 * `@fastify/swagger`, which reads those same schemas at startup and assembles
 * an OpenAPI document from them, and it serves the result.
 *
 * That direction is the whole point. A hand-written document is a second
 * contract: it can say `fix_kind` accepts three values while the server
 * accepts two, and nothing fails. Here the document cannot disagree with the
 * server, because it is made of the server.
 *
 * Registration order matters and is not incidental. The plugin collects routes
 * through an `onRoute` hook, so it must be in place before any route is added.
 * A route registered first is simply absent from the document, silently — the
 * one failure mode that produces a plausible-looking contract with a hole in
 * it.
 *
 * "Before" means when the hook is installed, not when `register` is called.
 * Fastify defers plugins: `register` queues, and the hook does not exist until
 * the queue runs at `ready()`. A route added directly to the instance in the
 * meantime is registered first in real time and is missed — which is what
 * happened to `/health` while this was being written, and why every route now
 * goes through a queued plugin rather than straight onto the instance. A test
 * asserts the inventory is complete rather than trusting the ordering to stay
 * right.
 *
 * OpenAPI 3.1, because 3.0 cannot express what these schemas already say.
 * `type: ['string', 'null']`, `enum` containing `null`, `enum: [true]` and
 * `minProperties` are all ordinary JSON Schema, which 3.1 adopts wholesale;
 * 3.0 would need them rewritten into its own `nullable` dialect. Rewriting
 * runtime schemas to suit a document format would be exactly the inversion
 * this task exists to avoid, so the format moved instead.
 *
 * No UI. A rendered explorer is a different deliverable with its own
 * dependencies, static assets and content-security questions, and nothing here
 * needs one to consume a JSON document.
 */

import type { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';

/** Where the generated document is served. Outside the owner-scoped prefix. */
export const OPENAPI_PATH = '/openapi.json';

/**
 * The version of the API contract, not of the package.
 *
 * It describes the `/v1` surface and moves when that surface changes shape.
 * Tying it to the package version would make every unrelated release look like
 * a contract change to anything watching this number.
 */
export const API_CONTRACT_VERSION = '0.1.0';

/**
 * Groupings, for readers and generators that sort by them.
 *
 * Classification only — no behaviour depends on a tag, and adding one changes
 * nothing about how a route is served. Kept deliberately small: a taxonomy
 * with a category per endpoint sorts nothing.
 *
 * Closing and transitioning both sit under Problems. They are things done to a
 * Problem, and giving each its own heading would suggest they are separate
 * resources when they are two ways of moving one.
 */
export const OPENAPI_TAGS = [
  {
    name: 'Operational',
    description: 'Whether the process is serving. Not part of the Memory API.',
  },
  { name: 'Owner', description: 'The owner this request is acting as.' },
  { name: 'Projects', description: 'The codebases and efforts problems belong to.' },
  {
    name: 'Environments',
    description: 'Point-in-time snapshots of the conditions a problem occurred under.',
  },
  {
    name: 'Problems',
    description: 'The unit of memory: one investigation, from first suspicion to conclusion.',
  },
  { name: 'Events', description: 'What happened while a problem was being solved.' },
  { name: 'Verifications', description: 'Checks that actually established whether a state holds.' },
  { name: 'Relations', description: 'Stated links between two of your problems.' },
  { name: 'Usage', description: 'Records that past memory was drawn on.' },
  { name: 'Change History', description: 'How a problem changed, written by the service.' },
  { name: 'Memory Controls', description: 'How a problem should be used as memory.' },
] as const;

/**
 * Prose that belongs to the document rather than to any one operation.
 *
 * The things a client most needs to know are not visible in any single
 * schema — that a resource belonging to someone else is indistinguishable
 * from one that does not exist, that owner context is not something the
 * client supplies. Stated once here; the reasoning is in
 * `docs/api-contract.md`.
 */
const API_DESCRIPTION = [
  'A user-owned record of problem-solving experience, reusable across AIs and projects.',
  '',
  'This document is generated at startup from the schemas the server validates against. It is not maintained separately and cannot describe a contract the server does not enforce.',
  '',
  'Everything under `/v1` is owner-scoped. The owner is established server-side in the current MVP; no client-supplied credential exists yet, and `owner_id` in a response is data, not a credential. A resource belonging to another owner answers exactly as one that does not exist — a 404 with no way to tell the two apart, deliberately, because distinguishing them would confirm what it exists to hide.',
  '',
  'Writes to a Problem carry `expected_version`. A 409 `VERSION_CONFLICT` means the Problem moved since it was read; re-read it and decide again. Appending an Event or Verification carries a `client_event_id` instead — an idempotency key, where the first write wins and a retry returns what it wrote.',
  '',
  'See `docs/api-contract.md` for the semantics behind these rules.',
].join('\n');

/**
 * Installs generation and the endpoint that serves it.
 *
 * Must be called before any route is registered.
 */
export function registerOpenApi(app: FastifyInstance): void {
  void app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'AI Problem-Solving Memory API',
        version: API_CONTRACT_VERSION,
        description: API_DESCRIPTION,
      },
      tags: OPENAPI_TAGS.map((tag) => ({ ...tag })),
    },
  });

  // Queued behind the plugin above, so the route exists only once the hook
  // that would document it does. Registering it directly on the instance would
  // put it out of the generator's sight, and `hide` below would then be
  // decorative rather than the thing keeping it out.
  void app.register((scope, _options, done) => {
    // Outside `/v1` and unauthenticated: this is the public shape of the API,
    // not anyone's memory. Requiring an owner to read it would mean a client
    // could not learn how to establish one.
    scope.get(
      OPENAPI_PATH,
      {
        // Hidden from its own output. A document that documents the endpoint
        // serving it adds a line no generator needs and invites the question
        // of which version of itself it is describing.
        //
        // No response schema either. The document is an arbitrary object by
        // nature, and serialising it through a schema could only drop parts
        // of it.
        schema: { hide: true },
      },
      () => app.swagger(),
    );
    done();
  });
}
