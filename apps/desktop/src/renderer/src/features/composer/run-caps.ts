// Caps on what the composer holds of a session's runs. Each bounds a value the wire controls,
// so a reading holding all of it would be an unbounded cache.

/**
 * Status rows retained per run: several minutes of an active run, far past what a person
 * scrolls back through. The durable record is the session log.
 *
 * @consumedBy the composer's run reading
 */
export const RUN_STATUS_ROW_CAP = 32;

/**
 * Runs projected from the state stream at once. Terminal runs never leave the stream's
 * history, so the oldest-touched run is dropped first and what survives is what is moving.
 *
 * @consumedBy the composer's run reading
 */
export const PROJECTED_RUN_CAP = 200;

/**
 * Run ids named in the awaiting-projection sentence before the rest is a count. The sentence
 * tells a person which rows are not live; past a handful of ids it stops being a lookup. The
 * count still covers every run.
 *
 * @consumedBy the composer's run reading
 */
export const AWAITING_RUN_IDS_NAMED_CAP = 6;

/**
 * Intervention outcomes retained. The run controls record what they dispatched and what came
 * back; the durable record is the `interventions` table, which has no registered read.
 */
export const INTERVENTION_OUTCOME_CAP = 16;
