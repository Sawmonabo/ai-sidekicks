// The ledger frame's named bounds.
//
// `Spec-023 §Console Design (Meridian)` §The four bars, "Light on the machine":
// "Every cap, window, and timeout is a named constant with a one-line rationale".
// `core/constants.ts` is that place for the SUBSTRATE's domains and says so in its
// own header — "each view family adds its own module beside its subtree rather than
// widening this one, so a bound always sits next to the code that spends it". This
// is the ledger frame's module, and every bound below has a spender in this
// directory.
//
// A number that appears inline in this subtree and is not a layout literal is a
// review rejection: the rationale is the point, not the constant.
//
// `../structure/structure-bounds.ts` and `../cards/card-bounds.ts` are the family's
// other two, and the split is by SPENDER rather than by count: every value here has
// one inside `ledger/frame/`, and every value in each of those has one inside the
// subtree it sits in. See `structure-bounds.ts`' header for why the three are not
// folded into one.

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
 * Chromium's maximum element height, in CSS pixels.
 *
 * The reason the window is a cap and not an optimisation: past this a virtual
 * list's total-size spacer stops growing and every row below it is unreachable.
 */
export const LEDGER_MAX_ELEMENT_HEIGHT_PX = 33_554_431;

/**
 * Rows rendered beyond each edge of the viewport.
 *
 * Six is two rows more than the tallest burst a single frame's reveal drain can
 * push into view, so a fast scroll meets measured rows rather than a blank band,
 * and small enough that the rendered set stays a fraction of the window cap.
 */
export const LEDGER_OVERSCAN_ROWS = 6;

/**
 * The height a row is assumed to have before it has been measured, in pixels.
 *
 * A ledger line with a gutter, a kind label, and two lines of body measures near
 * this; the estimate only has to be close enough that the first paint's scrollbar
 * is not visibly wrong, because every mounted row replaces it with a measurement.
 */
export const LEDGER_ROW_HEIGHT_ESTIMATE_PX = 96;

/**
 * Tolerance, in pixels, within which the viewport counts as sitting at the tail.
 *
 * Sub-pixel scroll positions and a fractional row height mean an exact equality
 * test flickers between following and reading on every frame of a stream. One
 * ledger line's leading is the smallest band that cannot be crossed by rounding.
 */
export const LEDGER_TAIL_TOLERANCE_PX = 24;

/**
 * The epsilon every geometry comparison uses, in pixels.
 *
 * This console never compares two measurements without one. Half a pixel is below
 * anything a display can show and above the error a device-pixel-ratio division
 * introduces.
 */
export const LEDGER_GEOMETRY_EPSILON_PX = 0.5;

/**
 * Agreeing witnesses before the controller believes this display quantizes
 * programmatic `scrollTop` writes to whole pixels.
 *
 * Two, because one is an observation and two is a rule: a single readback can be
 * explained by a concurrent user scroll landing between the write and the read,
 * and the only cost of waiting for the second is one unskipped no-op write.
 */
export const SCROLL_QUANTIZATION_WITNESS_COUNT = 2;

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
 * The largest multiple of its fair share a lane behind the others may take.
 *
 * `reveal-engine.ts`'s second decision: catch-up raises a lane's rate and never jumps
 * it. Three is a visible catch-up that still leaves two thirds of the
 * frame's budget for the lanes that are keeping pace.
 */
export const REVEAL_CATCH_UP_MULTIPLIER = 3;

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

/**
 * Characters of already-revealed text the gate is shown behind the cursor.
 *
 * Enough to see the start of the line the cursor is on for the digit-period
 * carve-out, and small enough that the window is rebuilt in constant time no
 * matter how long the message has grown.
 */
export const REVEAL_GATE_TAIL_CHARACTERS = 64;
