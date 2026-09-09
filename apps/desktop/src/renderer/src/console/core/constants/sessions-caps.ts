// The sessions family's bounds: the back tier's visible rows, what the attention
// emitter remembers announcing, and what the shelf remembers a person set aside.

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
 * Attention items the notification emitter remembers having already announced.
 *
 * A bound rather than an unbounded set, because the thing being remembered is a wire
 * id and the projection is re-read for the life of a window: a console left open for
 * a week would otherwise hold every item it ever saw. Two hundred is roughly two
 * orders of magnitude above what a person has open at once, so the oldest id evicted
 * is one whose item cleared long ago — and re-announcing an item that survived an
 * eviction is a duplicate banner, never a lost one, which is the direction this cap
 * is allowed to be wrong in.
 */
export const ATTENTION_NOTIFIED_ITEM_CAP = 200;

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
