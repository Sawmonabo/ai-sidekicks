// The ledger structure's bounds: the chapter's two row caps, the rail's two painting
// ceilings, and the find walk.
//
// Spent inside `ledger/structure/`.

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
 * Rows one chapter's body holds at all — the mounted window and the head above it.
 *
 * TWICE the visible cap, and it is a derivation rather than a second number: a
 * chapter body retains what it is showing plus the clipped head a reader scrolls
 * back up into, and both are bounded by the same figure. Writing it as a product
 * keeps the two in step, so moving the visible cap moves this with it.
 *
 * It is a cap in its own right because it is what the body's ring is SIZED at: the
 * ring is allocated once at this length and then written in place, so nothing about
 * a chapter's retention grows with how long its run streams for.
 */
export const CHAPTER_BODY_RETAINED_ROW_CAP: number = CHAPTER_VISIBLE_ROW_CAP * 2;
/**
 * The widest a tick grows at the centre of the fisheye. Past roughly three the
 * magnified band stops reading as the same rail and starts reading as a second
 * control.
 */
export const RAIL_FISHEYE_MAX_SCALE = 2.6;
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
