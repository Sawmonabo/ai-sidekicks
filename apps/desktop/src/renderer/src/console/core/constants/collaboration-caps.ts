// The collaboration family's bounds: the composing indicator's three durations and the
// concurrent composers named before the line folds.
//
// The first three are ONE decision — a receiver's deadline and the two publisher windows
// stated against it — so a reader who moves any of them sees the other two.

/**
 * How long a human's composing indicator survives without a refresh, in
 * milliseconds.
 *
 * The receive half of the bound `Spec-023 §Console Design (Meridian)`'s
 * collaboration section states. It sits well inside the thirty-second Awareness
 * staleness window, so an indicator is gone from the screen long before the
 * protocol would garbage-collect the client that wrote it.
 *
 * The publisher half is the two bounds below, and both are stated against this one
 * rather than beside it: a receiver that clears at ten seconds is only correct while
 * a still-composing sender refreshes inside that window, so the three numbers are one
 * decision and a reader who moves this one has to see the other two.
 */
export const COMPOSING_RECEIVED_STALE_MS = 10_000;

/**
 * How often a composing sender re-publishes while a person is still typing, in
 * milliseconds.
 *
 * Comfortably under {@link COMPOSING_RECEIVED_STALE_MS}, so a reader's indicator is
 * refreshed twice over before it would expire and one dropped publication does not
 * blink the indicator off a screen the sender is still typing at. It is not smaller
 * than that margin needs: every publication is a wire call, and a keystroke-rate
 * emit would put one on the wire per character for the length of a message.
 */
export const COMPOSING_PUBLISH_INTERVAL_MS = 4_000;

/**
 * How long after the last keystroke a composing sender publishes its own clear, in
 * milliseconds.
 *
 * The sender's stop is an EDGE and the receiver's is a deadline, and this is why both
 * exist: a person who stops mid-sentence to think is not composing, and waiting for
 * the receiver's bound to notice would leave the indicator up for the whole of
 * {@link COMPOSING_RECEIVED_STALE_MS} after they had already stopped. Three seconds
 * is long enough that an ordinary pause between words does not flicker the indicator
 * and short enough that a reader is not told someone is typing when nobody is.
 */
export const COMPOSING_IDLE_STOP_MS = 3_000;

/**
 * Concurrent composers rendered by name before the line folds to a count.
 *
 * Above three the line stops being information and starts being motion: the names
 * churn faster than they can be read, and what a person actually wants from a
 * fourth composer is the fact that the room is busy.
 */
export const COMPOSING_NAMED_CAP = 3;
