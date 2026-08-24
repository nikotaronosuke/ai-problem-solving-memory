/**
 * What this adapter calls itself when it records that it did something.
 *
 * `source_ai` is provenance and nothing else: it says which assistant a record
 * came from, and it has never decided what anybody is allowed to read. The
 * server decides that from the authenticated owner, never from this field, and
 * this constant depends on that separation — a value that could widen a scope
 * would be a value worth spoofing, and this one is worth nothing.
 *
 * ## Why there is no version in it
 *
 * The obvious next thought is `claude-code/2.1.233`, and it is wrong for two
 * reasons. A Memory outlives the assistant version that wrote it by years, so
 * a version baked into the provenance of every record is a value that is
 * already stale in the rows and will be repeated a thousand times. And the
 * field is the one thing a later search groups on: "what did Claude Code find
 * here before" is a question about the assistant, not about the build.
 *
 * The same argument rules out a session id, a model name and a project path.
 * They vary per record and this does not.
 *
 * ## Why the model never sees it
 *
 * It is supplied by the adapter, not by whatever is being written about. A
 * value the model chose would say what the model believed it was, and the one
 * question `source_ai` answers is what actually made the call.
 */
export const CLAUDE_CODE_SOURCE_AI = 'claude-code';
export const CODEX_SOURCE_AI = 'codex';

/** The host attribution an authenticated runtime may attach to a write. */
export type RuntimeSourceAi = typeof CLAUDE_CODE_SOURCE_AI | typeof CODEX_SOURCE_AI;

/**
 * Provenance established by the host edge, outside every model-owned schema.
 *
 * This is descriptive rather than authorising: owner scope still comes from
 * the Memory credential. Keeping it as a separate value prevents a model's
 * input object from acquiring a field that looks like an identity override.
 */
export interface RuntimeProvenance {
  readonly sourceAi: RuntimeSourceAi;
}

export const CLAUDE_CODE_RUNTIME_PROVENANCE: RuntimeProvenance = {
  sourceAi: CLAUDE_CODE_SOURCE_AI,
};

export const CODEX_RUNTIME_PROVENANCE: RuntimeProvenance = { sourceAi: CODEX_SOURCE_AI };

/** Claude Code remains the default for existing direct adapter callers. */
export function runtimeSourceAi(provenance?: RuntimeProvenance): RuntimeSourceAi {
  return provenance?.sourceAi ?? CLAUDE_CODE_SOURCE_AI;
}
