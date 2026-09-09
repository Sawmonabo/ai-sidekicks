// The ledger frame's bounds: the retained window, the element ceiling the window
// exists to stay under, the reveal engine's per-frame budget, and the two tails it
// keeps.
//
// Spent inside `ledger/frame/`.

/**
 * Top-level rows the ledger window retains before the oldest are pruned.
 *
 * A ceiling rather than a nicety: Chromium caps an element's height at
 * `LEDGER_MAX_ELEMENT_HEIGHT_PX`, so an uncapped log eventually renders rows the
 * browser cannot place. Four hundred rows is several screens of scrollback at the
 * ledger's density, which is as far back as a person reads before reaching for
 * find or the rail.
 */
export const LEDGER_WINDOW_ROW_CAP = 400;
/**
 * Rows one backward read of a session's log asks the daemon for.
 *
 * The read is registered with its own ceiling — `TIMELINE_READ_LIMIT_MAX`, 256 rows —
 * and this is deliberately well under it, because the two numbers bound different
 * things. That one is the largest window a producer may answer with; this is the
 * largest window a PERSON asked for by pressing a control once, and it lands in a
 * viewport whose own retention is {@link LEDGER_WINDOW_ROW_CAP}. Asking for the wire's
 * ceiling would spend most of a press filling rows the reader then has to scroll past
 * to reach the ones they wanted, and would put three presses over that retention with
 * the prune suppressed underneath them.
 *
 * Fifty is about a screenful and a half at the ledger's density, so one press moves the
 * head far enough to be worth the round trip and near enough that the rows it brought
 * are reachable without a second scroll.
 */
export const LEDGER_EARLIER_PAGE_ROWS = 50;
/**
 * Chromium's maximum element height, in CSS pixels.
 *
 * The reason the window is a cap and not an optimisation: past this a virtual
 * list's total-size spacer stops growing and every row below it is unreachable.
 */
export const LEDGER_MAX_ELEMENT_HEIGHT_PX = 33_554_431;
/**
 * Characters the reveal engine publishes per frame, across every lane.
 *
 * Sized to the frame budget rather than to reading speed: at 60 Hz this is roughly
 * 28,000 characters a second, which outruns every provider's output while leaving
 * the frame's remaining time to layout. The per-lane share is this figure divided
 * across the lanes that have work, so four lanes each advance every frame instead
 * of one lane finishing while three wait.
 */
export const REVEAL_FRAME_CHARACTER_BUDGET = 480;
/**
 * Checkpoints a lane retains for its authoritative commits.
 *
 * The tail is bounded because a checkpoint exists to re-anchor a commit that
 * arrived out of band, and a commit older than a few frames is one the engine has
 * already published past. Eight frames of history is a tenth of a second.
 */
export const REVEAL_CHECKPOINT_TAIL_CAP = 8;
/**
 * Pruned rows whose leased state the window parks under a synthetic key.
 *
 * Bounded for the reason every cache in the console is: a person who pages back
 * expects the row they had open to still be open, and nobody expects that of a row
 * pruned an hour ago. Parking one window's worth covers a page back and no more.
 */
export const LEDGER_PARKED_LEASE_CAP = 400;
/**
 * How far the reveal gate walks back from a candidate ceiling looking for a
 * literal-safe stopping point.
 *
 * Bounded because a run of volatile characters — a rule of asterisks, a table
 * border — would otherwise make the walk proportional to the block's length on
 * every frame. Eight characters covers every incomplete construct the gate can
 * withhold (a fence, a link opener, an emphasis run) and refuses to become a scan.
 */
export const REVEAL_LITERAL_BACKTRACK_CAP = 8;
