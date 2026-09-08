// The command palette's list bounds and the keybinding when-clause's parse bounds.
//
// One surface: the palette renders the ranked list a when-clause decides the membership
// of, so the enumeration's row ceiling and the clause parser's depth sit beside it.

/** Commands the palette remembers. Enough to cover a working session's rhythm. */
export const PALETTE_RECENTS_CAP = 8;

/**
 * Ranked results the palette renders at once. The list is keyboard-walked, so
 * past this a person is scrolling rather than choosing and should refine instead.
 */
export const PALETTE_RESULT_CAP = 40;

/**
 * Rows a bounded enumeration shows before it scrolls.
 *
 * Six, and the number is a ceiling rather than a preference. The shortest window
 * the console ships is 720 px tall (the agent-console auxiliary geometry), which is
 * 45 rem at the 16 px root; an enumeration allowed to take more than a third of
 * that would leave the surface holding it with nothing else on screen. Six rows is
 * 13.875 rem and clears that third; seven is 16.1875 rem and does not. The rem
 * height itself is the token family's, because it is this count multiplied by a row
 * height the type and space scales decide.
 */
export const BOUNDED_ENUMERATION_MAX_ROWS = 6;

/**
 * Maximum nesting depth of a keybinding when-clause. Bounded so a malformed or
 * hostile expression cannot recurse the parser; past the bound the clause is
 * refused and the binding evaluates false, which is the fail-closed arm.
 */
export const WHEN_CLAUSE_MAX_DEPTH = 8;

/**
 * Distinct context keys a pair of when-clauses may name before
 * `whenClausesCanOverlap` stops enumerating.
 *
 * Twelve keys is 4096 assignments per pair, checked only for bindings that share a
 * chord — microseconds, once, at install. It is set by what a human writes: a
 * console clause names two or three keys, and a pair naming thirteen is a design
 * smell long before it is a performance problem.
 */
export const WHEN_CLAUSE_OVERLAP_MAX_CONTEXT_KEYS = 12;
