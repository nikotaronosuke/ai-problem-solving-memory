/**
 * Whether an OpenAI retrieval stack can exist in this process.
 *
 * One environment variable decides, and the answer is deliberately binary:
 * a usable credential means the providers can be built, anything else means
 * the retrieval stack is absent and the Memory Server runs as it always has —
 * recording, reading, everything except generating artifacts. A missing key
 * is not a startup failure, because a Memory that cannot summarise itself yet
 * is still a Memory; making the whole server refuse to start over it would
 * hold canonical records hostage to a search convenience.
 *
 * The value is read here and travels into the transport, and nowhere else.
 * Nothing echoes it, measures it, or validates its shape: what an OpenAI key
 * looks like is OpenAI's rule, it has changed before, and presenting it and
 * being told no is the correct way to find out.
 */

/** The one variable this provider family reads. */
export const OPENAI_API_KEY_ENV = 'OPENAI_API_KEY';

/** What the composition edge learns: build the stack, or do not. */
export type OpenAiRetrievalConfig =
  { readonly enabled: false } | { readonly enabled: true; readonly apiKey: string };

/**
 * Reads the credential, without judging it.
 *
 * Missing and blank are both "disabled" — a blank value is the shape an
 * unset variable arrives in through one more layer of tooling, and neither is
 * a credential OpenAI could meaningfully refuse.
 */
export function resolveOpenAiRetrievalConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): OpenAiRetrievalConfig {
  const apiKey = environment[OPENAI_API_KEY_ENV];
  if (apiKey === undefined || apiKey.trim() === '') {
    return { enabled: false };
  }
  return { enabled: true, apiKey };
}
