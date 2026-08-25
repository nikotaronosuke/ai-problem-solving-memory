/**
 * The whole pipeline, end to end: a Problem in, a stored artifact out.
 *
 * This is the composition point three tasks have been building towards. The
 * summary service turns a Problem into a draft and stores nothing; the artifact
 * store accepts only complete rows; between them sits the embedding, and this
 * service is where the three meet. After it runs successfully, a Problem has a
 * current artifact and the lexical search can find it.
 *
 * The design question the whole file answers is *when things are allowed to
 * happen*, because the two calls in the middle are slow and everything around
 * them is racing:
 *
 * **The draft is obtained, never accepted.** There is no method taking a
 * caller's draft. A draft that came through the summary service has been
 * validated, inspected for credentials and race-checked; one handed in from
 * outside has been none of those things, and an API accepting it would be a
 * door around every boundary P4-02 built. So this service calls the summary
 * service itself, and the only thing a caller can supply is a Problem id.
 *
 * **Nothing external happens inside a transaction.** The generator may take
 * seconds; the embedding provider may take seconds. Holding a connection —
 * let alone a row lock — across either would make somebody's inference time
 * into everybody's lock time. Both calls finish before the transaction begins.
 *
 * **The write is atomic with its own justification.** After the embedding
 * exists, the source is read once more *under a lock on the Problem row*, the
 * fingerprint is compared, and the artifact is written — all in one short
 * transaction. The lock is what turns "checked, then wrote" into one act:
 * measured against the real schema, an Event append, a Verification append,
 * every Problem update, a delete and a competing artifact write all block on
 * it until the commit, so the source cannot move between the check and the
 * write. What the commit guarantees is exactly that: *at the moment this
 * artifact was written, its fingerprint described the source*. A moment later
 * an Event may land and make it stale — the lock releases, the append
 * proceeds, and that is ordinary life for derived data, handled by
 * regeneration rather than prevented by this service.
 */

import type { DatabaseExecutor } from '../db/executor.js';
import type { DatabaseTransactionRunner } from '../db/transaction.js';
import type { OwnerContext } from '../domain/owner.js';
import type { ProblemId } from '../domain/problem.js';
import type { RetrievalArtifactRecord } from '../domain/retrieval-artifact.js';
import {
  EmbeddingGenerationFailedError,
  requireEmbeddingProviderIdentity,
  toProviderEmbedding,
  type EmbeddingProvider,
} from '../domain/retrieval-embedding.js';
import { fingerprintRetrievalSource } from '../domain/retrieval-summary.js';
import {
  createRetrievalArtifactRepository,
  createRetrievalSummarySourceReader,
  lockProblemForArtifactWrite,
} from '../repository/index.js';
import { createArtifactInspectionPolicy, withSanitization } from '../sanitization/index.js';
import type { RetrievalSummaryService } from './retrieval-summary-service.js';

/**
 * What happened. The three ordinary non-answers are the summary service's,
 * passed through with their meanings intact; `STORED` is this service's own.
 *
 * No distinction between a first artifact and a replacement. The store keeps
 * one current row per Problem, so "created or updated" is a fact about what
 * happened to be there before — asking would cost an extra read inside the
 * gate and tell a caller nothing it can act on.
 */
export type GenerateRetrievalArtifactOutcome =
  | { readonly kind: 'STORED'; readonly artifact: RetrievalArtifactRecord }
  | { readonly kind: 'SOURCE_NOT_AVAILABLE' }
  | { readonly kind: 'SOURCE_CHANGED' }
  | { readonly kind: 'MEMORY_READ_DISABLED' };

// Re-exported from the embedding domain, where it moved when vector search
// became the second caller of a provider. Existing importers keep working;
// the error itself is one situation with one name, wherever it is raised.
export { EmbeddingGenerationFailedError } from '../domain/retrieval-embedding.js';

export interface RetrievalArtifactGenerationService {
  /**
   * Generates and stores one Problem's artifact, replacing any current one.
   *
   * Leaves every Memory table untouched whatever the outcome. On anything but
   * `STORED`, the artifact that was there before — if any — is still there,
   * with one honest exception: a Problem deleted mid-generation takes its
   * artifact with it, because the delete path removes both, and that is the
   * delete path's answer rather than this service's.
   */
  generateArtifact(problemId: ProblemId): Promise<GenerateRetrievalArtifactOutcome>;
}

/**
 * Builds the service.
 *
 * The summary service arrives as a dependency rather than being built here, so
 * whatever generator it was composed with is the one this pipeline uses —
 * there is exactly one place a summary can come from. `now` exists for tests:
 * `generated_at` means "when the complete content first existed", and a test
 * asserting that needs to hold the clock still.
 */
export function createRetrievalArtifactGenerationService(
  summaryService: RetrievalSummaryService,
  // `null` is the deterministic stack: the artifact stores its searchable
  // text with no semantic rendering, which the schema holds as one state.
  embeddingProvider: EmbeddingProvider | null,
  transactionRunner: DatabaseTransactionRunner,
  ownerContext: OwnerContext,
  now: () => Date = () => new Date(),
): RetrievalArtifactGenerationService {
  if (embeddingProvider !== null) {
    requireEmbeddingProviderIdentity(embeddingProvider);
  }

  return {
    async generateArtifact(problemId): Promise<GenerateRetrievalArtifactOutcome> {
      // Everything P4-02 established still holds: validation, the privacy
      // refusal, the read control, and the race check up to the moment the
      // draft existed. A non-GENERATED answer is already the right answer.
      const summary = await summaryService.generateSummary(problemId);
      if (summary.kind !== 'GENERATED') {
        return summary;
      }

      // The provider sees the summary verbatim — the same bytes that will be
      // stored as `normalized_summary`, so the embedding's input is always
      // reproducible from the row it ends up in. Nothing else is sent: no
      // keywords (the lexical channel's), no features (the structural task's),
      // no identifiers. With no provider there is no call to make and no
      // rendering to store — not a degraded run, the ordinary Tier-0 one.
      let embedding: ReturnType<typeof toProviderEmbedding> | null = null;
      if (embeddingProvider !== null) {
        let embedded: unknown;
        try {
          embedded = await embeddingProvider.embed({ text: summary.draft.normalizedSummary });
        } catch {
          throw new EmbeddingGenerationFailedError();
        }
        embedding = toProviderEmbedding(embedded, embeddingProvider);
      }

      // The moment the complete content first existed: summary and embedding
      // both in hand, both checked. Not the insert time — the row may commit
      // a moment later — and not the summary's time, which was only part of
      // the content.
      const generatedAt = now();

      // The gate. Everything from here to the commit happens under a lock on
      // the Problem row, and both external calls are already behind us.
      return await transactionRunner.run(async (executor: DatabaseExecutor) => {
        const held = await lockProblemForArtifactWrite(executor, ownerContext, problemId);
        if (!held) {
          return { kind: 'SOURCE_NOT_AVAILABLE' } as const;
        }

        // The same reader the draft came through, over the transactional
        // executor. The lock makes this read final rather than merely latest:
        // nothing that could change it can commit until we do.
        const current = await createRetrievalSummarySourceReader(executor, ownerContext).readSource(
          problemId,
        );
        if (current === undefined) {
          return { kind: 'SOURCE_NOT_AVAILABLE' } as const;
        }
        if (!current.memoryReadEnabled) {
          // Turned off somewhere between the draft's check and now. The
          // fingerprint cannot see this — a control is not content — so it is
          // its own check, here as in the summary service.
          return { kind: 'MEMORY_READ_DISABLED' } as const;
        }
        if (
          fingerprintRetrievalSource(current.canonicalSource) !== summary.draft.sourceFingerprint
        ) {
          return { kind: 'SOURCE_CHANGED' } as const;
        }

        // The same boundary every artifact write crosses, over the same
        // executor so the write commits or vanishes with the gate. The draft
        // was inspected before the provider saw it; this is the second look,
        // and it stays because the first one being upstream is a fact about
        // today's call graph, not a property of storage.
        const artifacts = withSanitization(
          createRetrievalArtifactRepository(executor, ownerContext),
          createArtifactInspectionPolicy(),
        );

        const artifact = await artifacts.upsertArtifact({
          problemId,
          normalizedSummary: summary.draft.normalizedSummary,
          keywords: summary.draft.keywords,
          structuralFeatures: summary.draft.structuralFeatures,
          summaryGeneratorId: summary.generatorId,
          summaryGeneratorVersion: summary.generatorVersion,
          semantic:
            embeddingProvider === null || embedding === null
              ? null
              : {
                  embedding,
                  embeddingModel: embeddingProvider.modelId,
                  embeddingModelVersion: embeddingProvider.modelVersion,
                },
          sourceFingerprint: summary.draft.sourceFingerprint,
          generatedAt,
        });

        return { kind: 'STORED', artifact } as const;
      });
    },
  };
}
