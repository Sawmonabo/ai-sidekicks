// Caps on what the composer holds of a session's runs. Each bounds a value the wire controls,
// so a reading holding all of it would be an unbounded cache.

/**
 * Intervention outcomes retained. The run controls record what they dispatched and what came
 * back; the durable record is the `interventions` table, which has no registered read.
 */
export const INTERVENTION_OUTCOME_CAP = 16;
