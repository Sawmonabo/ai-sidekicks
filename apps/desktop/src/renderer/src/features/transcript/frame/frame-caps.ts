// The transcript frame's bounds: the retained window, the reveal engine's per-frame budget
// and its tails.

/**
 * Top-level rows the transcript window retains before the oldest are pruned.
 *
 * A ceiling: Chromium places no element taller than 33,554,431 px, so an uncapped log
 * eventually renders rows the browser cannot place. Four hundred rows is several screens of
 * scrollback, as far back as a person reads before reaching for find.
 */
export const TRANSCRIPT_WINDOW_ROW_CAP = 400;
/**
 * Rows one backward read of a session's log asks the daemon for.
 *
 * Well under the contract's `TIMELINE_READ_LIMIT_MAX` (256 rows): that is the most a producer
 * may answer with, this is what one press should land in a viewport retaining
 * {@link TRANSCRIPT_WINDOW_ROW_CAP}. The wire ceiling would fill most of a press with rows the
 * reader scrolls past, and three presses would exceed the retention with the prune suppressed.
 * Fifty is about a screenful and a half.
 */
export const TRANSCRIPT_EARLIER_PAGE_ROWS = 50;
/**
 * Characters the reveal engine publishes per frame, across every lane.
 *
 * Sized to the frame budget, not reading speed: about 28,000 characters a second at 60 Hz,
 * which outruns every provider's output and leaves the frame time for layout. The per-lane
 * share is this divided across the lanes with work.
 */
export const REVEAL_FRAME_CHARACTER_BUDGET = 480;
/**
 * Checkpoints a lane retains for its authoritative commits.
 *
 * A checkpoint re-anchors a commit that arrived out of band; one older than a few frames
 * (eight is about 130 ms at 60 Hz) is one the engine has already published past.
 */
export const REVEAL_CHECKPOINT_TAIL_CAP = 8;
/**
 * Pruned rows whose leased state the window parks under a synthetic key.
 *
 * Bounded like every cache here: a person who pages back expects the row they had open to
 * still be open, not one pruned an hour ago. One window's worth covers a page back.
 */
export const TRANSCRIPT_PARKED_LEASE_CAP = 400;
/**
 * How far the reveal gate walks back from a candidate ceiling looking for a literal-safe
 * stopping point.
 *
 * Bounded so a run of volatile characters (a rule of asterisks, a table border) cannot make
 * the walk proportional to the block's length every frame. Eight covers every incomplete
 * construct the gate withholds (a fence, a link opener, an emphasis run).
 */
export const REVEAL_LITERAL_BACKTRACK_CAP = 8;
