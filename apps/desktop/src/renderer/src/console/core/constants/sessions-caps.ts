// The sessions family's bound: what the attention emitter remembers announcing.

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
