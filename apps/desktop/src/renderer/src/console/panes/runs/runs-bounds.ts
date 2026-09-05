// The runs pane's named bounds.
//
// `console/core/constants.ts` holds the substrate's; it says in as many words that
// "each view family adds its own module beside its subtree rather than widening
// this one, so a bound always sits next to the code that spends it". This is that
// module for the runs pane, and it follows `shell/composer/accessories/
// accessory-bounds.ts` in shape: one exported number per bound, each with the
// sentence that explains why it is that number and not another.
//
// Every one of these bounds a value the WIRE controls. A session's runs, a run's
// status history, and a session's queue are all as long as the daemon says they
// are, and a surface that held all of any of them would be a renderer-side leak
// with no ceiling — which `Spec-023 §Console Design (Meridian)` forbids in its
// budget rules ("no unbounded caches").

/**
 * Status rows retained per run.
 *
 * A run's transition history is what the pane's expanded detail reads, and thirty
 * two rows is several minutes of an active run at the rate a driver transitions —
 * far past what a person scrolls back through in a live view, and small enough
 * that a hundred concurrent runs cost thousands of rows rather than millions. The
 * durable record is the session log, which is not this.
 */
export const RUN_STATUS_ROW_CAP = 32;

/**
 * Runs projected from the state stream at once.
 *
 * A session's runs accumulate for as long as the session is open, and terminal
 * runs never leave the stream's history. The oldest-touched run is dropped first,
 * so what survives is what is moving — the reading a live pane exists to give.
 */
export const PROJECTED_RUN_CAP = 200;

/**
 * Intervention outcomes retained.
 *
 * The pane records what it dispatched and what came back; it is not the durable
 * audit record, which lives on the `interventions` table and has no registered
 * read. Sixteen is more than a person issues in one sitting and bounds a list that
 * would otherwise grow for the window's whole life.
 */
export const INTERVENTION_OUTCOME_CAP = 16;

/**
 * Queue rows rendered before the remainder is folded into a count.
 *
 * The cap is spent by a `slice` and a withheld count, which is the whole mechanism:
 * this family windows nothing and imports no windowing layer, so a comment promising
 * virtualization would describe a component that does not exist. Below the cap the
 * list is a plain block; above it the surface says how many rows it is not drawing
 * rather than drawing them all. The queue is FIFO and the head is what matters, so
 * the ceiling truncates the tail and never the front.
 */
export const QUEUE_ROWS_RENDERED_CAP = 50;
