// The one grammar that tells an identifier from authored content.
//
// Authored prose carries spaces, punctuation and length; identifiers are bounded,
// whitespace-free and drawn from a narrow charset, so a value whose strings all pass
// `IDENTIFIER_PATTERN` cannot carry a message, a path, a name or a line of code. This is one of
// two conjuncts at the store's write chokepoint; the other, that no admitted class has a field
// that takes a path, is in `store/persistence/persisted-value-classes.ts`. The grammar is its own
// module so the charset, the ceiling and the path-separator exclusion read on one screen.

/**
 * The longest identifier the persistence grammar admits. A UUID is 36 characters and a
 * namespaced command id is well under this; prose is not. Both the durable value walk and the
 * pane address parse hold to it.
 */
export const IDENTIFIER_MAX_LENGTH = 128;

/**
 * The identifier charset: no whitespace, no quotes, no brackets. It covers UUIDs, dotted method
 * and command names, `kind:id` refs and chord strings like `$mod+Shift+P`.
 */
const IDENTIFIER_PATTERN: RegExp = new RegExp(
  `^[A-Za-z0-9._:@/#+$-]{1,${String(IDENTIFIER_MAX_LENGTH)}}$`,
);

/** True when a string is identifier-shaped and therefore not authored content. */
export function isIdentifierShaped(value: string): boolean {
  return IDENTIFIER_PATTERN.test(value);
}

/**
 * The one character an address excludes that a value string may carry. The charset admits `/`
 * because the class shapes keep paths out of values, but an address is two bare strings with no
 * shape behind it. `\` is already outside the charset.
 */
const PATH_SEPARATOR = "/";

/**
 * True when a string may name one thing: a record address's component, or the id on an entity
 * reference. An identifier that is not path-shaped, so the charset and ceiling stay written once.
 * The pane address parse uses it so route resolution never accepts an id the durable path refuses.
 */
export function isSingleNameIdentifierShaped(component: string): boolean {
  return isIdentifierShaped(component) && !component.includes(PATH_SEPARATOR);
}
