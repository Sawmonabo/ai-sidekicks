// The ledger frame's named figures that are not ceilings.
//
// THE CEILINGS ARE NOT HERE. `test/console/architecture/cap-constant-home.test.ts`
// names `core/constants.ts` the one module a bound may be DECLARED in, so the window
// cap, the element ceiling, the reveal engine's frame budget and its two walk caps,
// and the parked-lease cap are declared there and read through the core door. What
// stays is the estimate, the tolerance, the epsilon, the overscan, the witness count,
// the catch-up multiplier, and the gate's tail window — measurements and factors
// rather than bounds anything is checked against.
//
// `Spec-023 §Console Design (Meridian)` §The four bars, "Light on the machine":
// "Every cap, window, and timeout is a named constant with a one-line rationale".
// That rule is about the NAME and the rationale rather than the file, which is why
// the ceilings can move to the home and still satisfy it — each went with the
// paragraph it was written with.
//
// A number that appears inline in this subtree and is not a layout literal is a
// review rejection: the rationale is the point, not the constant.
//
// `../structure/structure-bounds.ts` and `../cards/card-bounds.ts` are this family's
// other two, on the same split: every value here has a spender inside
// `ledger/frame/`, and every value in each of those has one inside the subtree it
// sits in.

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
 * The largest multiple of its fair share a lane behind the others may take.
 *
 * `reveal-engine.ts`'s second decision: catch-up raises a lane's rate and never jumps
 * it. Three is a visible catch-up that still leaves two thirds of the
 * frame's budget for the lanes that are keeping pace.
 */
export const REVEAL_CATCH_UP_MULTIPLIER = 3;

/**
 * Characters of already-revealed text the gate is shown behind the cursor.
 *
 * Enough to see the start of the line the cursor is on for the digit-period
 * carve-out, and small enough that the window is rebuilt in constant time no
 * matter how long the message has grown.
 */
export const REVEAL_GATE_TAIL_CHARACTERS = 64;
