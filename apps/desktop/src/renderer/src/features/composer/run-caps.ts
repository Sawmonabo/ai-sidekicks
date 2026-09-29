// The caps on what the composer holds of a session's runs.
//
// Every one of them bounds a value the WIRE controls: a session's runs and a run's
// status history are as long as the daemon says they are, and a reading holding all of
// either would be an unbounded cache.

/**
 * Status rows retained per run.
 *
 * A run's transition history is what the expanded detail reads, and thirty
 * two rows is several minutes of an active run at the rate a driver transitions —
 * far past what a person scrolls back through in a live view, and small enough
 * that a hundred concurrent runs cost thousands of rows rather than millions. The
 * durable record is the session log, which is not this.
 *
 * @consumedBy the composer's run reading
 */
export const RUN_STATUS_ROW_CAP = 32;

/**
 * Runs projected from the state stream at once.
 *
 * A session's runs accumulate for as long as the session is open, and terminal
 * runs never leave the stream's history. The oldest-touched run is dropped first,
 * so what survives is what is moving — the reading a live view exists to give.
 *
 * @consumedBy the composer's run reading
 */
export const PROJECTED_RUN_CAP = 200;

/**
 * Rows drawn from the session's own record before the remainder is a count.
 *
 * Deliberately well under `PROJECTED_RUN_CAP`, and for a different reason than that
 * bound has. The projection cap bounds a live reading of what is MOVING; these rows
 * are runs the live stream has said nothing about, drawn from the session's `run`
 * partition — which is folded from the log, never evicted, and so as long as the
 * session is old. They are appended after every projected row, which puts them at
 * the bottom of a list that already holds up to two hundred, and each one carries
 * less than a projected row does: no confirmed run version, no status history, no
 * controls. Fifty is past what a person scrolls to at the end of that list, and the
 * order is newest-touched first, so the ones that fall off are the coldest.
 *
 * @consumedBy the composer's run reading
 */
export const RECORDED_RUN_ROW_CAP = 50;

/**
 * Run ids named in the awaiting-projection sentence before the rest is a count.
 *
 * The sentence exists so a person can tell WHICH of the rows in front of them is not
 * live, and that is a lookup: past a handful of ids it stops being one and becomes a
 * paragraph of hex nobody reads. The count still names every run, drawn or not, so
 * nothing disappears from the reading — only from the enumeration.
 *
 * @consumedBy the composer's run reading
 */
export const AWAITING_RUN_IDS_NAMED_CAP = 6;

/**
 * Intervention outcomes retained.
 *
 * The run controls record what they dispatched and what came back; this is not the
 * durable audit record, which lives on the `interventions` table and has no registered
 * read. Sixteen is more than a person issues in one sitting and bounds a list that
 * would otherwise grow for the window's whole life.
 */
export const INTERVENTION_OUTCOME_CAP = 16;
