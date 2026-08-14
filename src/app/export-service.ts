/**
 * Handing an owner their Memory as a file they can keep.
 *
 * The Memory is theirs. This is the operation that says so in the strongest
 * available way: everything, in one document, readable without this server.
 *
 * The service is thin on purpose. It does not know what tables exist, what
 * order they come in, or that the artifact was built by a single statement to
 * keep it internally consistent — all of that is storage's business and lives
 * in `src/db/memory-export.ts`. What is decided here is the one product
 * question an export raises: whether it may leave at all.
 *
 * That question exists because of what came before. P3-02 and P3-03 stop a
 * credential from being written into Memory, and P3-05 gives a way to remove
 * one that was written before those existed. Neither helps with a record that
 * still holds one right now, at the moment somebody asks for a file they will
 * put in a backup, a cloud drive, or an email.
 *
 * So an export that would carry a confirmed credential does not happen. Three
 * options were weighed and two rejected:
 *
 * Redacting on the way out was rejected because it breaks the thing the export
 * is for. The completion condition is that the format can be read back into a
 * clean environment; an artifact that silently differs from the database is no
 * longer a copy of the Memory, and restoring it would quietly replace real
 * content with markers.
 *
 * Exporting it anyway was rejected because it is the largest single egress in
 * the system. Everything else here answers one request about one record; this
 * hands over the lot, into a file whose travels nobody tracks.
 *
 * What is left is to refuse, and to say so in a way the owner can act on: they
 * have a delete path, and it was built one task ago. Only *confirmed*
 * credentials block — the same certainty line P3-02 drew, for the same reason.
 * Suspicion is not enough to withhold somebody's own data from them.
 *
 * Nothing is changed by any of this. An export that is refused leaves the
 * Memory exactly as it was: no redaction written back, no Problem invalidated,
 * no flag set. Reading your own data must not edit it.
 */

import { ExportBlockedError } from './errors.js';
import type { AuthenticatedRequestContext } from './request-context.js';
import type { MemoryExportArtifact } from '../domain/memory-export.js';
import {
  createExportInspectionPolicy,
  SanitizationRejectedError,
  sanitizeValue,
} from '../sanitization/index.js';

export interface ExportService {
  /**
   * The context owner's whole Memory, as a portable document.
   *
   * Raises `ExportBlockedError` when the Memory holds a confirmed credential.
   * Nothing is written in either case.
   */
  exportMemory(context: AuthenticatedRequestContext): Promise<MemoryExportArtifact>;
}

export function createExportService(): ExportService {
  // Built by the sanitization boundary, not here. What a credential looks like
  // is that directory's to know: a service able to ask the detector directly
  // would also be able to disagree with it, and an architecture test pins that
  // nothing outside it names the detector at all.
  //
  // The policy's outcomes differ from the write boundary's, and that is the
  // whole difference between the two. Reasoning is where it is built.
  const policy = createExportInspectionPolicy();

  return {
    async exportMemory(context) {
      const artifact = await context.repository.exportOwnerMemory();

      // Parsed only to look at. `JSON.parse` loses microseconds from a
      // timestamp and precision from a large number, so this copy is not the
      // export and must never become the response — the artifact returned
      // below is the untouched text the database produced. Reading a lossy
      // copy is fine: a credential does not hide in the digits that were lost.
      const inspectable: unknown = JSON.parse(artifact.json);

      try {
        // The existing walker, which visits every string reachable in the
        // document — values, object keys, and everything nested inside an
        // environment snapshot or a change log. Its result is discarded; what
        // matters is whether the policy raised.
        sanitizeValue(inspectable, policy, [{ kind: 'operation', name: 'exportOwnerMemory' }]);
      } catch (error) {
        if (error instanceof SanitizationRejectedError) {
          // Translated rather than propagated. The boundary's error carries a
          // locator describing where in the document the credential sits, and
          // that is useful in a server log and wrong in a response: it would
          // tell whoever asked which of their records to look at, in a message
          // that travels wherever the response does. The owner is told that
          // something is there and can find it with the tools they have.
          throw new ExportBlockedError();
        }
        throw error;
      }

      return artifact;
    },
  };
}
