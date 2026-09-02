// The sessions subtree's named bounds.
//
// `core/constants.ts` holds the substrate's; its own header sets the rule this
// file follows — "each view family adds its own module beside its subtree rather
// than widening this one, so a bound always sits next to the code that spends it".
// Every number here carries the one line that says why it is that number.

/**
 * Back-tier rows the all-sessions list shows before folding the rest under a
 * count (the design's density rule: "the back tier folds to a count when it
 * exceeds the visible budget").
 *
 * Five, because the back tier is the demoted half of the list and its job is to
 * stay reachable without competing with the front tier for the same screen. A
 * taller budget makes the divider stop meaning anything; a shorter one folds a
 * tier that had barely begun.
 */
export const SESSION_BACK_TIER_VISIBLE_CAP = 5;

/**
 * Invitations the shelf remembers a person set aside.
 *
 * Bounded because the hide set is a durable cache and an unbounded cache is a
 * store that grows for as long as the install lives. Sixty-four is generous
 * against the shape of the thing — an invitation is a rare, expiring object, and
 * a person with more than this many set aside has a different problem — and the
 * set is pruned against every served read besides, so the cap is the second line
 * of defence rather than the first.
 */
export const HIDDEN_INVITE_CAP = 64;
