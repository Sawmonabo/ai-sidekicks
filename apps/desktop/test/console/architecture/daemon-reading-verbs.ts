// Which repos wrappers READ, as the verbs the contracts name their responses with.
//
// ONE GATE NOW, AND THE SECOND ONE IS WHY THIS FILE STILL EXISTS SEPARATELY. It was
// written when two gates shared the set: `prerequisite-read-round.test.ts` classified a
// repos wrapper by the response type it declares and `daemon-read-signal-census.ts`
// classified a registry row by the schema it was bound to, from two hand-written lists
// — one spelled as suffixes and one as words — so a fourth reading verb moved whichever
// list its author remembered. That census no longer classifies by NAME at all: the
// console declares the partition itself, in `bridge/daemon/daemon-method-classification.ts`,
// and a word rule over a schema identifier is a naming convention wearing a
// classifier's clothes. What is left here is the one derivation that still has a
// subject a name is the right instrument for.
//
// WHY THAT ONE IS DIFFERENT, and not the same mistake one file over. Its subject is a
// FUNCTION rather than a wire method: a repos wrapper declares
// `Promise<DaemonReply<X>>` and there is no per-wrapper classification anywhere for it
// to read, because a wrapper is this console's own module rather than a row of a closed
// contract. The declared response type is the only statement about it that exists, and
// the gate that reads it asserts its own floors so a derivation that classified nothing
// fails rather than passes.
//
// WORDS AND NOT SUBSTRINGS, which is the whole difference between a classifier and a
// coincidence — kept as the suffix rule this gate has always used, because its subject
// is a declared `…Response` type and widening it would change what that gate
// classifies without anybody asking for it.

/** The noun a declared response type carries, and what the suffix form is built on. */
const RESPONSE_NOUN = "Response";

/**
 * The operation words that make a wrapper's response a reading, as the wire's own verbs.
 *
 * Three, and the set is closed on purpose: a fourth reading verb landing in the
 * contracts is a deliberate edit here, where a reviewer meets the classification,
 * rather than a wrapper that silently classifies as a mutation and stops being held to
 * the read-round rule.
 */
export const READING_VERBS: readonly string[] = ["Read", "List", "Check"];

/** The response types a reading wrapper declares, one per verb. */
export function readingResponseSuffixes(
  verbs: readonly string[] = READING_VERBS,
): readonly string[] {
  return verbs.map((verb) => `${verb}${RESPONSE_NOUN}`);
}

/** Whether a DECLARED response type name is a reading's, by the suffix it ends in. */
export function answersReadingResponse(
  responseTypeName: string,
  verbs: readonly string[] = READING_VERBS,
): boolean {
  return readingResponseSuffixes(verbs).some((suffix) => responseTypeName.endsWith(suffix));
}
