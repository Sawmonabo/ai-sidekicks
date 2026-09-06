// The ledger structure's named figures that are not ceilings.
//
// THE CEILINGS ARE NOT HERE. `test/console/architecture/cap-constant-home.test.ts`
// names `core/constants.ts` the one module a bound may be DECLARED in, so the chapter
// cap, the rail's fisheye and painting maxima, and the find walk's cap are declared
// there and read through the core door. What stays is the rail's geometry, its
// preview grace, its thumb floor, and the replay interval.
//
// Every value below is spent by a module in this directory and by nothing else,
// which is also why this file did not fold into one `ledger-bounds.ts` when its
// ceilings left: `frame-bounds.ts` and `cards/card-bounds.ts` are the family's
// other two, no two of the three share a spender, and folding them would move
// every remaining figure away from the code that spends it to satisfy a count.
//
// `Spec-023 §Console Design (Meridian)` §The four bars, "Light on the machine":
// "Every cap, window, and timeout is a named constant with a one-line rationale".

/**
 * The rail's pointer strip, in CSS pixels.
 *
 * `rail-model.ts` fixes the rail's geometry as a ≥32px hit strip and a dead
 * gutter. The strip is wider than the drawn rail on purpose: a tick is two
 * pixels of ink and a pointer is not, so the strip is what a person aims at and
 * the ink is what they read.
 */
export const RAIL_HIT_STRIP_WIDTH_PX = 32;

/**
 * The drawn rail, inset inside the hit strip. The remainder is the dead gutter —
 * pointer-inert space that keeps a rail click from landing on the pane behind it.
 */
export const RAIL_INK_WIDTH_PX = 12;

/**
 * How far up and down the rail the fisheye reaches from the pointer, in CSS
 * pixels. One tick is a few pixels tall, so a radius under about forty
 * magnifies one tick and its neighbours — which is the point — while a larger one
 * magnifies a stretch nobody is pointing at.
 */
export const RAIL_FISHEYE_RADIUS_PX = 36;

/**
 * How long the pointer rests on a tick before its preview card opens.
 *
 * `rail-model.ts`'s rule: the card activates after a short
 * grace, with no debounce on the read. The grace is what keeps a pointer crossing
 * the rail from opening thirty cards; the READ is immediate, so the card that
 * does open is the tick under the pointer now and never one it has left.
 */
export const RAIL_PREVIEW_GRACE_MS = 160;

/**
 * The shortest the rail's viewport thumb is drawn, as a fraction of the rail.
 *
 * A window of ten thousand rows shows five of them, and the honest extent for that
 * is half a pixel of a 600px rail — a thumb nobody can see and nobody can aim at.
 * One percent is the floor at which the thumb still reads as a band rather than as
 * a hairline. It is spent by the one clamp in `rail-model.ts`, which takes the
 * floor out of the extent and off the top in the same act, so a raised floor can
 * never push the thumb past the rail's bottom.
 */
export const RAIL_THUMB_MIN_EXTENT = 0.01;

/**
 * How often replay advances its position while playing, in milliseconds of real
 * time. Twenty frames a second: fast enough that a 1× replay reads as motion,
 * slow enough that a 32× replay does not schedule work the reveal engine cannot
 * absorb. It is a scheduled timeout through `core/clock.ts`, never an interval.
 */
export const REPLAY_FRAME_INTERVAL_MS = 50;
