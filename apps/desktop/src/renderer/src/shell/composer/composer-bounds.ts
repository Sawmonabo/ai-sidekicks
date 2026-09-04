// The composer family's named bounds.
//
// `console/core/constants.ts` holds the substrate's domains and says in its own
// header that "each view family adds its own module beside its subtree rather than
// widening this one, so a bound always sits next to the code that spends it". This
// is that module for the composer, and it exists for the same reason the substrate's
// does: a number that appears inline is a decision nobody wrote down.
//
// Both bounds below are spent by exactly one module today. They live here rather
// than in that module because the next zone to want either would otherwise copy it,
// and two copies of one ceiling drift in the direction nothing catches.

/**
 * Sent messages the directive line's history recall walks.
 *
 * A recall list is a convenience, not an archive — the ledger is the archive. Deep
 * enough to reach the message before last after a correction and a retry, shallow
 * enough that ArrowUp stays a gesture rather than a search. Past this the person is
 * looking for something and the ledger is what they should be looking in.
 */
export const COMPOSER_HISTORY_RECALL_CAP = 20;

/**
 * Composer addresses whose recall history one window retains.
 *
 * History is per address, so re-addressing the composer never walks another
 * target's sent messages into this line — and coming back to an address finds its
 * own history intact, which a reset on every rebinding would have destroyed. That
 * makes the map grow with the addresses a person visits, and a window left open all
 * day visits many, so the least recently addressed is dropped past this bound.
 *
 * Sized so an ordinary working set — a session's channel and the agents on it —
 * never evicts, while a long day of browsing cannot grow the map without end.
 */
export const COMPOSER_RETAINED_ADDRESS_CAP = 12;

/**
 * Lines the directive line grows to before it scrolls.
 *
 * `Spec-023 §Console Design (Meridian)` puts the composer at "one line that grows
 * to a cap". The cap is what keeps the composer from eating the ledger it is
 * addressed within: past this the input scrolls inside its own box and the session
 * above it keeps its room.
 */
export const COMPOSER_DIRECTIVE_LINE_MAX_ROWS = 8;
