// Which kind of posture reading a card is rendering.

/**
 * Which kind of posture reading this is.
 *
 * `stamped` is a fact about a run that happened. `intent` is a projection of configured
 * intent for the NEXT run. The two are kept visibly distinct because no wire member
 * carries an agent-level or composer-level posture — a posture is a projection of the
 * daemon's stamp and never of a request — and a chip that looked identical would imply
 * one had been enforced.
 */
export type PostureReading = "stamped" | "intent";
