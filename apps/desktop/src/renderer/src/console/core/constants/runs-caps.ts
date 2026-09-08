// The runs pane's bounds, and the two durations a run's stall reading is drawn against.
//
// The stall thresholds stood under the shutdown budget's banner in the single-module
// home; they bound what the console says about a RUN that has gone quiet, so they are
// read here beside the caps on the rows that run appears in.

// Every one of the six below bounds a value the WIRE controls: a session's runs, a
// run's status history, and a session's queue are all as long as the daemon says they
// are, and a surface holding all of any of them would be the unbounded cache
// `Spec-023 §Console Design (Meridian)` forbids in its budget rules. They were
// declared in the runs family beside their readers, which `apps/desktop/AGENTS.md`
// §Config single-sourcing and `cap-constant-home.test.ts` between them do not allow:
// a bound declared in a view family is a ceiling nobody audits.

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
 * Rows seated from the session's own record before the remainder is a count.
 *
 * Deliberately well under `PROJECTED_RUN_CAP`, and for a different reason than that
 * bound has. The projection cap bounds a live reading of what is MOVING; these rows
 * are runs the live stream has said nothing about, seated from the session's `run`
 * partition — which is folded from the log, never evicted, and so as long as the
 * session is old. They are appended after every projected row, which puts them at
 * the bottom of a pane that already holds up to two hundred, and each one carries
 * less than a projected row does: no confirmed run version, no status history, no
 * controls. Fifty is past what a person scrolls to at the end of that list, and the
 * order is newest-touched first, so the ones that fall off are the coldest.
 */
export const SEATED_KNOWN_RUN_CAP = 50;

/**
 * Run ids named in the awaiting-projection sentence before the rest is a count.
 *
 * The sentence exists so a person can tell WHICH of the rows in front of them is not
 * live, and that is a lookup: past a handful of ids it stops being one and becomes a
 * paragraph of hex nobody reads. The count still names every run, seated or not, so
 * nothing disappears from the reading — only from the enumeration.
 */
export const AWAITING_RUN_IDS_NAMED_CAP = 6;

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
 * that family windows nothing and imports no windowing layer, so a comment promising
 * virtualization would describe a component that does not exist. Below the cap the
 * list is a plain block; above it the surface says how many rows it is not drawing
 * rather than drawing them all. The queue is FIFO and the head is what matters, so
 * the ceiling truncates the tail and never the front.
 */
export const QUEUE_ROWS_RENDERED_CAP = 50;

/**
 * How long a run must have been making no progress before the console says so.
 *
 * The daemon decides whether a run is stuck — `health.stuckRunInspect` answers
 * `stuck-suspected` or `healthy`, and this console composes neither. What this bound
 * governs is the SENTENCE beside that answer: below it the quiet interval is not worth
 * a figure on screen, because a run between two tool calls is ordinarily quiet for a
 * few seconds and a surface that reported every one of them would report nothing.
 *
 * Sixty seconds because that is the threshold the design names for the badge
 * appearing at all, and stating it once here is what keeps the console's reading of
 * "quiet" from being one number in a component and another in its test.
 */
export const STUCK_RUN_NOTICE_MS = 60_000;

/**
 * How long that quiet has to last before the same badge escalates its presentation.
 *
 * Five minutes, and it changes the badge's TONE and its sentence — never its verdict,
 * which stays the daemon's. A run quiet for six minutes and one quiet for seventy
 * seconds are both `stuck-suspected` to the daemon and are not the same thing to a
 * person deciding whether to interrupt, and this is the whole of the difference the
 * console is allowed to draw between them.
 *
 * A SIBLING OF THE NOTICE BOUND AND NOT A MULTIPLE OF IT. The two are read from the
 * same design sentence as two independent thresholds, and deriving one from the other
 * would make the ratio the thing a later change has to preserve rather than the two
 * durations a reader can check against the design.
 */
export const STUCK_RUN_ESCALATION_MS = 300_000;
