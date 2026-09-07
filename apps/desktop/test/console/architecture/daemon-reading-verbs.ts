// Which wire operations READ, as the verbs the contracts name them with.
//
// ONE SET, TWO GATES, AND IT WAS WRITTEN TWICE. `prerequisite-read-round.test.ts`
// classifies a repos wrapper by the response type it declares and
// `daemon-read-signal-census.ts` classifies a registry row by the schema it is bound
// to, and both were asking the same question of the same three verbs from two
// hand-written lists — one spelled as suffixes (`ReadResponse`, `ListResponse`,
// `CheckResponse`) and one as words (`Read`, `List`, `Check`). Two spellings of one
// closed set is what `apps/desktop/AGENTS.md` rejects, and the cost is specific: a
// fourth reading verb landing in the contracts moves whichever list its author
// remembered and leaves the other gate classifying that verb as a mutation, silently,
// which is the exemption both files exist to refuse.
//
// SO THE SET IS DECLARED HERE AND BOTH DERIVATIONS ARE TAKEN FROM IT. Both take the
// verbs as a parameter, so a control can widen the set and watch the two answers move
// together — which is the only way to show that a single source really is single
// rather than two lists that happen to agree today.
//
// WORDS AND NOT SUBSTRINGS, which is the whole difference between a classifier and a
// coincidence. `ChecklistUpdateResponse` CONTAINS "Check" and records;
// `ListModelsResult` carries its reading verb at the head rather than the tail, so a
// suffix rule misses it. Splitting the operation name on its own capital-letter
// boundaries answers both: a reading verb is a WORD of the operation, wherever in the
// name it sits.
//
// THE SUFFIX DERIVATION IS DELIBERATELY NARROWER, because its subject is. A repos
// wrapper declares `Promise<DaemonReply<X>>` and every read in that module answers an
// `X` whose verb is the last word before the noun; widening it to the word rule would
// change what that gate classifies without anybody asking for it. One set, two rules
// about how the set is spelled where each gate reads it.

/** The noun a declared response type carries, and what the suffix form is built on. */
const RESPONSE_NOUN = "Response";

/** The nouns a bound schema's operation is named with, stripped before the verb is looked for. */
const RESPONSE_NOUNS: readonly string[] = [RESPONSE_NOUN, "Result"];

/** The suffix every bound schema identifier carries. */
const SCHEMA_SUFFIX = "Schema";

/**
 * The operation words that make a call a reading, as the wire's own verbs.
 *
 * Three, and the set is closed on purpose: a fourth reading verb landing in the
 * contracts is a deliberate edit here, where a reviewer meets the classification,
 * rather than a method that silently classifies as a mutation and stops being held to
 * the signal rule.
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

/** Whether a BOUND schema identifier names a reading, by the words of its operation. */
export function namesReadingVerb(
  responseSchemaName: string,
  verbs: readonly string[] = READING_VERBS,
): boolean {
  return operationWords(responseSchemaName).some((word) => verbs.includes(word));
}

/**
 * The operation a response schema names, split into its own capital-bounded words.
 *
 * `QueueItemListResponseSchema` is the operation `QueueItemList` and the words
 * `Queue`, `Item`, `List`; `RunControlAckSchema` carries no response noun to strip and
 * is `Run`, `Control`, `Ack`. Stripping the noun matters because it is where a reading
 * verb would otherwise be looked for and never found.
 */
function operationWords(responseSchemaName: string): readonly string[] {
  let operation = responseSchemaName.endsWith(SCHEMA_SUFFIX)
    ? responseSchemaName.slice(0, -SCHEMA_SUFFIX.length)
    : responseSchemaName;
  for (const noun of RESPONSE_NOUNS) {
    if (operation.endsWith(noun)) {
      operation = operation.slice(0, -noun.length);
      break;
    }
  }
  return operation.match(/[A-Z][a-z0-9]*/g) ?? [];
}
