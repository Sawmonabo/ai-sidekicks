// The account plane's quota reading: what its opening read buffers, and the scale its
// utilization bar is drawn against.
//
// The full-scale value stood under the shutdown budget's banner in the single-module
// home, which is a heading it never belonged to — it bounds a quota bar's fill and is
// read beside the notification buffer above it.

/**
 * Account-plane notifications held while that registry's OPENING read is in
 * flight.
 *
 * The tail opens before the read, and the read's reply restates the whole
 * registry at an instant the tail has already moved past — so a removal or a
 * credential-generation bump that arrives in that window has to be replayed
 * AFTER the snapshot seats or the snapshot silently undoes it. The buffer's
 * lifetime is therefore one round trip, and its size is whatever the tail bursts
 * inside one: a node's accounts and their limit windows are a handful, so this is
 * a memory bound rather than a policy. Past it the reading stops buffering,
 * applies what it holds live, and takes a FRESH read — nothing is dropped,
 * because the tail emits no second notification for a mutation it already
 * reported.
 */
export const PROVIDER_QUOTA_PENDING_NOTIFICATION_CAP = 64;

/**
 * The full-scale value a utilization bar is drawn against, and the clamp on its fill.
 *
 * A quota reading can exceed its own limit — a provider that admitted a request over
 * an allowance still reports what was spent — and an unclamped `<progress>` fill past
 * its `max` renders as a full bar in one engine and an overflowing one in another. So
 * the BAR is clamped and the FIGURE beside it is not: the bar answers "how full", which
 * saturates, and the percentage answers "how much", which does not. Clamping both
 * would hide an overage; clamping neither would draw one wrong.
 *
 * One rather than a hundred because the fraction is what `Intl` takes for a percent,
 * so the same number serves the bar's scale and the figure's input and there is no
 * second unit anywhere on the row to get backwards.
 */
export const UTILIZATION_BAR_FULL_SCALE = 1;
