// The one grammar that tells an identifier from authored content, and the record
// address it validates.
//
// `Spec-023 §Console Design (Meridian)` makes a write outside the closed
// value-class enumeration a tripwire failure at the store's write chokepoint, and
// the hard part of that is mechanical: how does a chokepoint tell an expansion set
// from a sentence? This module is one of the two conjuncts that do it.
// Participant- and machine-authored content is prose: it carries spaces,
// punctuation, and length. Identifiers are bounded, whitespace-free, and drawn from
// a narrow charset. A value whose strings all pass `IDENTIFIER_PATTERN` cannot be
// carrying a message, a path, a name, or a line of code. The other conjunct — every
// admitted class declares a shape, and no class has a field that takes a path —
// lives in `value-classes.ts`, and neither conjunct would do alone.
//
// A RECORD IS A VALUE AND AN ADDRESS, and the address half is settled here.
// `partition` and `key` are written to the record verbatim, so validating the value
// alone would leave a caller free to persist a sentence or a path in the key while
// handing the value check an ordinary boolean.
//
// WHY THIS IS ITS OWN MODULE. The grammar is a decision about STRINGS and is wrong
// when a string the store could have held is refused, or when one it could not is
// admitted. The class table next door is a decision about SHAPES and is wrong when
// a value's structure is misread. Two failure modes, and one of them — the charset,
// the ceiling, the path-separator exclusion — is the half a reviewer has to be able
// to read on one screen without the seven class shapes around it.

import { refusePersistence, type PersistenceRefusal } from "./refusals.js";

/**
 * The longest identifier the store admits. A UUID is 36 characters and a
 * namespaced command id is well under this; prose is not.
 */
export const IDENTIFIER_MAX_LENGTH = 128;

/**
 * The identifier charset: no whitespace, no quotes, no brackets. Chosen from what
 * the corpus's own identifiers actually use — UUIDs, dotted method and command
 * names, `kind:id` refs, chord strings like `$mod+Shift+P`.
 */
export const IDENTIFIER_PATTERN: RegExp = /^[A-Za-z0-9._:@/#+$-]{1,128}$/;

/** True when a string is identifier-shaped and therefore not authored content. */
export function isIdentifierShaped(value: string): boolean {
  return value.length <= IDENTIFIER_MAX_LENGTH && IDENTIFIER_PATTERN.test(value);
}

/**
 * The one character an ADDRESS excludes that a value string may carry.
 *
 * The charset above admits `/` deliberately, and the header says why: a
 * path-shaped VALUE is excluded by the class shapes instead, because no admitted
 * class has a field that takes a path. An address has no class shape behind it —
 * `partition` and `key` are two bare strings the caller chooses — so the
 * exclusion the value side gets from its shape has to be made at the address
 * itself. The Windows separator needs no entry: `\` is outside the charset, so
 * `isIdentifierShaped` already refuses it.
 */
const PATH_SEPARATOR = "/";

/**
 * True when a string may name ONE thing: a record address's component, or the id on
 * an entity reference.
 *
 * Derived from the one grammar rather than declared as a second one: such a string is
 * an identifier that is additionally not path-shaped, so the charset and the length
 * ceiling are still written in exactly one place.
 *
 * EXPORTED FOR THE PANE ADDRESS, and the two callers want the same thing for the same
 * reason. A layout row's entity id is a string this family already holds to
 * `isIdentifierShaped` on the way to disk, so a pane-address parse that admitted any
 * non-empty string would have route resolution accept an id the durable path refuses —
 * two boundaries onto one value, disagreeing. The separator exclusion carries over
 * too: an id names one row, and a value that can encode a path is a value a body can
 * be talked into resolving.
 */
export function isSingleNameIdentifierShaped(component: string): boolean {
  return isIdentifierShaped(component) && !component.includes(PATH_SEPARATOR);
}

/**
 * The chokepoint's ADDRESS validator.
 *
 * `partition` and `key` are written to the record verbatim, so a caller that
 * derived either from participant- or machine-authored input would put prose, a
 * path, or a name into durable storage while handing the value check a perfectly
 * ordinary boolean. Validating one half of a record and copying the other half
 * through is not a chokepoint, it is a chokepoint on one field.
 *
 * A code of its own rather than a reuse of `value-not-identifier-shaped`: the
 * store counts refusals BY CODE for the diagnostics surface, and an operator
 * reading a count that named values while every one of them was an address would
 * go and audit the wrong half of every write.
 *
 * Neither component is echoed, only its length and which half it is — the same
 * discipline the value walk keeps, because a refusal that quotes the prose it
 * refused has carried that prose one layer further out than the store that
 * stopped it.
 */
export function validatePersistedAddress(
  partition: string,
  key: string,
): PersistenceRefusal | undefined {
  const components = [
    ["partition", partition],
    ["key", key],
  ] as const;
  for (const [component, value] of components) {
    if (!isSingleNameIdentifierShaped(value)) {
      return refusePersistence(
        "address-not-identifier-shaped",
        `the record ${component} is not identifier-shaped (${String(value.length)} chars, ceiling ${String(IDENTIFIER_MAX_LENGTH)}, no path separator). A record address is an identifier; participant- and machine-authored content has no durable home in the renderer.`,
      );
    }
  }
  return undefined;
}
