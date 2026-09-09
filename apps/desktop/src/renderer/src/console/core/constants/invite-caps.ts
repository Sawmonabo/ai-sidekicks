// The deep-link invite path's three registers.

/**
 * How many invitations awaiting confirmation this window holds at once.
 *
 * A bound rather than an unbounded list, because the pending feed's producer is the
 * operating system: every press of an invite link fires the protocol handler again,
 * and a window that queued each one would grow a list nobody is reading for as long
 * as it stays open.
 *
 * DROPPING THE SURPLUS IS RECOVERABLE, WHICH IS WHY A BOUND IS ADMISSIBLE AT ALL. The
 * main process holds each reference until an act releases it, and re-opening the feed
 * re-delivers every one that is still held — so a frame this window declines to queue
 * is not lost, it is simply not on screen yet. Eight is well past any real arrival
 * burst and small enough that the whole queue fits in one reading.
 */
export const PENDING_INVITE_QUEUE_MAX = 8;

/**
 * How many refused previews this window holds BESIDE that queue, waiting for a slot.
 *
 * A SECOND REGISTER BECAUSE THE RECOVERY ABOVE DOES NOT COVER THIS ARM. The bound
 * beside it is admissible because main holds every reference and re-delivers it; a
 * REFUSED preview minted no reference, so main holds nothing for it and replays
 * nothing — deferring one to that replay drops it for the life of the window, and the
 * expired, revoked, or already-accepted explanation a person is owed is gone. So a
 * refusal past the queue's bound is retained here instead and promoted the moment a
 * release makes room.
 *
 * EIGHT, LIKE THE QUEUE, ON A DIFFERENT ARGUMENT. The queue's eight is what fits in
 * one reading; this eight is how many terminal explanations may sit behind a person
 * who has answered nothing at all. Past it the OLDEST retained refusal is dropped
 * rather than the newest turned away: a register that refused new arrivals while
 * holding stale ones would let one burst blind the window to every later refusal,
 * which is worse than losing the oldest of sixteen unread prompts.
 */
export const PENDING_INVITE_RETAINED_REFUSAL_MAX = 8;

/**
 * How many turned-away arrivals keep their place in the order both registers share.
 *
 * THE PLACE AND NOT THE ARRIVAL. Nothing is queued here: main holds the arrival and
 * re-delivers it, and what this bounds is the handle-and-number pair the window
 * remembers so a replayed frame re-enters where it ARRIVED rather than behind
 * everything that arrived while it waited. A bound for the same reason the queue has
 * one — the producer is the operating system — and for one of its own: a place is
 * cleared only when the replay brings its arrival back, which for a reference main has
 * since let go never happens, so nothing here drains on a quiet feed.
 *
 * SIXTEEN, TWICE THE QUEUE, because this register's subject is precisely what did NOT
 * fit in it. One the same width could remember places for no more arrivals than are
 * already on screen, which is the wrong scale for a bound whose whole job is the
 * overflow; twice covers a burst two queues deep, at a handle and a number each.
 *
 * PAST IT THE NEWEST DEFERRAL KEEPS NO PLACE — the opposite disposition from the
 * register above, for the opposite reason. The arrival is still deferred and still
 * replayed, because the debt is recorded either way, so nothing is lost; what it gives
 * up is only its priority against the refusals retained beside it, re-entering as
 * though it had just arrived if the replay finds the queue still at its bound.
 * Dropping the OLDEST place instead would surrender exactly the claim the order exists
 * to protect.
 */
export const PENDING_INVITE_DEFERRED_PLACE_MAX = 16;
