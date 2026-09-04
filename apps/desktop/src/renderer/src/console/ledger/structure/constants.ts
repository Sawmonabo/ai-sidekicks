// The ledger structure's named bounds.
//
// `core/constants.ts` states the rule this file follows: "each view family adds
// its own module beside its subtree rather than widening this one, so a bound
// always sits next to the code that spends it". Every value below is spent by a
// module in this directory and by nothing else.
//
// `Spec-023 §Console Design (Meridian)` §The four bars, "Light on the machine":
// "Every cap, window, and timeout is a named constant with a one-line rationale".

/**
 * Rows a single chapter renders before its body clips.
 *
 * The cap on a chapter's visible rows, held here rather than inside the fold so the
 * bound sits beside the rest of the structure family's. A chapter is a nested scroller, so the
 * cap is not about what fits on screen — it is about how many rows one run may
 * mount at once while three sibling runs stream beside it. 120 is four screens of
 * ledger at this density: enough that scrolling inside a chapter is reading
 * rather than paging, and far short of the point where four live chapters cost a
 * frame.
 */
export const CHAPTER_VISIBLE_ROW_CAP = 120;

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
 * The widest a tick grows at the centre of the fisheye. Past roughly three the
 * magnified band stops reading as the same rail and starts reading as a second
 * control.
 */
export const RAIL_FISHEYE_MAX_SCALE = 2.6;

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
 * Ticks the rail paints per column of ink.
 *
 * The rail draws the loaded window, which the ledger's own timeline cap already
 * bounds; this is the second bound, and it is a painting bound rather than a data
 * one — past one tick per pixel the marks overdraw and the minimap stops being a
 * map. Ticks beyond it are folded into the nearest painted column, never dropped.
 */
export const RAIL_MAX_TICKS_PER_PIXEL = 1;

/**
 * How often replay advances its position while playing, in milliseconds of real
 * time. Twenty frames a second: fast enough that a 1× replay reads as motion,
 * slow enough that a 32× replay does not schedule work the reveal engine cannot
 * absorb. It is a scheduled timeout through `core/clock.ts`, never an interval.
 */
export const REPLAY_FRAME_INTERVAL_MS = 50;

/**
 * Matches the find field ranks and offers next/previous over.
 *
 * The field searches the loaded window, and a query of one character matches most
 * of it; past this the count stops being a number a person acts on and the
 * next/previous walk stops terminating in a session. The cap bounds the walkable
 * set, so the counter's denominator is that set and the true match count rides
 * beside it as a second figure — a denominator naming matches no press can reach
 * is a promise the walk cannot keep.
 */
export const FIND_MATCH_CAP = 500;
