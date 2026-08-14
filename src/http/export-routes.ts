/**
 * The export route.
 *
 * `GET /v1/export` returns everything belonging to the credential's owner. No
 * body, no query, no path parameter: there is exactly one thing a caller can
 * ask for here, and who they are is settled by the credential as everywhere
 * else.
 *
 * One thing here is unlike every other route, and it is the reason this file
 * exists rather than a handler alongside the others.
 *
 * The response body is sent as the database produced it, byte for byte, and is
 * deliberately not re-serialised. Everywhere else a route returns a JS object
 * and Fastify serialises it through the response schema, which is right when
 * the values are strings, integers and booleans. An export is neither: it
 * carries timestamps to the microsecond and numbers from environment snapshots
 * that can exceed what a JS number holds. Parsing that text into an object and
 * stringifying it again silently rewrites both — `...00.123456Z` becomes
 * `...00.123Z`, and 12345678901234567890 becomes 12345678901234567000. The
 * artifact would still be valid JSON and would no longer be the Memory.
 *
 * So the handler overrides the serialiser for this one reply and passes the
 * text through. The schema below still describes the shape for the generated
 * contract; it just no longer decides the bytes.
 *
 * That has a second effect worth having. `fast-json-stringify` reports a type
 * mismatch by quoting the offending value — `The value "..." cannot be
 * converted to an integer` — and an error raised while serialising reaches the
 * unhandled branch, which logs the error object. Running the largest body in
 * the system through it would be a new way for Memory content to land in an
 * operational log. Passing the text through cannot fail that way. The general
 * question of what serialisation errors may say is P3-10's, and nothing here
 * settles it.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AuthenticatedRequestContext, ExportService } from '../app/index.js';
import { MEMORY_EXPORT_SCHEMA_VERSION } from '../domain/memory-export.js';
import { ERROR_RESPONSE_SCHEMA } from './errors.js';
import { MEMORY_EXPORT_RESPONSE_SCHEMA } from './resources.js';

function contextOf(request: FastifyRequest): AuthenticatedRequestContext {
  const context = request.memoryContext;
  if (context === undefined) {
    throw new Error('Route reached without an authenticated context.');
  }
  return context;
}

export function registerExportRoutes(scope: FastifyInstance, service: ExportService): void {
  scope.get(
    '/export',
    {
      schema: {
        operationId: 'exportOwnerMemory',
        summary: 'Export everything this owner has recorded',
        description: `Returns the owner's whole Memory as one document: projects, environments, problems, events, verifications, relations, usage logs and change logs, with every identifier preserved so the relationships survive. The Memory belongs to the person who recorded it, and this is the form it takes when it leaves.\n\nRead-only. Exporting changes nothing.\n\nEvery collection key is always present; an owner with nothing recorded gets eight empty arrays. \`source_owner_id\` appears once, at the top, instead of on every record: it names the Memory this artifact came from, and it is not a credential — presenting it authenticates nothing. \`schema_version\` describes this format and moves independently of the API contract version.\n\nA Memory holding a credential cannot be exported: the response is 409 \`EXPORT_BLOCKED\`, and the record has to be removed first. Nothing is redacted on the way out, because an artifact that differs from the database is no longer a copy of it.`,
        tags: ['Export'],
        response: {
          200: MEMORY_EXPORT_RESPONSE_SCHEMA,
          401: ERROR_RESPONSE_SCHEMA,
          409: ERROR_RESPONSE_SCHEMA,
          500: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply: FastifyReply) => {
      const artifact = await service.exportMemory(contextOf(request));

      // The bytes the database produced, unchanged. See the note above: this
      // is the whole reason the route is written this way.
      await reply
        .header('content-type', 'application/json; charset=utf-8')
        .serializer((payload: unknown) => payload as string)
        .send(artifact.json);
    },
  );
}

/**
 * The format version, re-exported for the contract test.
 *
 * The document pins it as a constant, so a change to the export format that
 * forgets to move the version fails there rather than reaching a reader who
 * trusts it.
 */
export { MEMORY_EXPORT_SCHEMA_VERSION };
