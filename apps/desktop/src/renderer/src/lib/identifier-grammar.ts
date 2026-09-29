// The one grammar that tells an identifier from authored content.
//
// A write outside the closed value-class enumeration is a tripwire failure at the store's
// write chokepoint, and the hard part of that is mechanical: how does a chokepoint tell
// an expansion set from a sentence? This module is one of the two conjuncts that do it.
// User- and machine-authored content is prose: it carries spaces, punctuation, and
// length. Identifiers are bounded, whitespace-free, and drawn from a narrow charset. A
// value whose strings all pass `IDENTIFIER_PATTERN` cannot be carrying a message, a path,
// a name, or a line of code. The other conjunct — every admitted class declares a shape,
// and no class has a field that takes a path — lives in `store/persistence/persisted-value-classes.ts`, and neither
// conjunct would do alone.
//
// WHY THIS IS ITS OWN MODULE. The grammar is a decision about STRINGS and is wrong
// when a string the store could have held is refused, or when one it could not is
// admitted. The class table in `store/persistence/` is a decision about SHAPES and is wrong when
// a value's structure is misread. Two failure modes, and one of them — the charset,
// the ceiling, the path-separator exclusion — is the half a reviewer has to be able
// to read on one screen without the seven class shapes around it.
/**
 * The longest identifier the persistence grammar admits. A UUID is 36 characters
 * and a namespaced command id is well under this; prose is not.
 *
 * Held to by two boundaries rather than one — the durable value walk and the pane
 * address parse — which is why it is a bound with a home and not a literal beside
 * either of them.
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
 * reason. A layout row's entity id is a string the persistence layer already holds to
 * `isIdentifierShaped` on the way to disk, so a pane-address parse that admitted any
 * non-empty string would have route resolution accept an id the durable path refuses —
 * two boundaries onto one value, disagreeing. The separator exclusion carries over
 * too: an id names one row, and a value that can encode a path is a value a body can
 * be talked into resolving.
 */
export function isSingleNameIdentifierShaped(component: string): boolean {
  return isIdentifierShaped(component) && !component.includes(PATH_SEPARATOR);
}
