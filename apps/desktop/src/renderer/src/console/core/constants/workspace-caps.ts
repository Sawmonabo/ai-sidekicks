// The workspace chrome's bounds: the cast bar's chip fold, the sidebar's width range,
// and the load hairline's progress range.
//
// Three surfaces of one frame, and two of them are RANGES — a floor and a ceiling that
// a clamp reads together, which is why each range keeps one home.

/**
 * Participant chips the cast bar shows before folding to "+N" (rule 7).
 *
 * Consumed by T-023p-1C-2, which builds the cast bar; every other bound in this
 * file has a live spender today and this one does not. It is kept rather than
 * deferred to that task because the number is a decision `Spec-023 §Console
 * Design (Meridian)` already fixed, and a bound re-derived at the point of use is
 * a bound that can come back different.
 */
export const CAST_BAR_CHIP_CAP = 8;

// `SIDEBAR_MAX_WIDTH_PX` is the bound of the three and is what brought them here; the
// other two came with it because the width is clamped between them on every read, and
// a range split across two modules is a clamp a reviewer opens two files to check.

/**
 * How wide the sidebar opens when nobody has resized it. Wide enough for a section
 * title plus its count without wrapping at the default type scale.
 */
export const SIDEBAR_DEFAULT_WIDTH_PX = 288;

/**
 * The narrowest the sidebar may be dragged. Below this the disclosure glyph, the
 * section glyph, and a two-word title stop fitting on one line, and the sidebar
 * becomes a column of ellipses rather than a navigation.
 */
export const SIDEBAR_MIN_WIDTH_PX = 208;

/**
 * The widest. Past this the sidebar is competing with the deck for the window rather
 * than pointing into it, and that sidebar's density rule is counts, not lists.
 */
export const SIDEBAR_MAX_WIDTH_PX = 480;

// `LOAD_PROGRESS_MAX` is the bound of the two and is what brought them here; the
// floor came with it on the sidebar range's rule above, because the hairline clamps
// between them on every paint and a range split across two modules is a clamp a
// reviewer opens two files to check.

/**
 * The floor of a reported load fraction.
 *
 * Zero rather than a hair above it: a load that has genuinely reported nothing yet is
 * a zero-width fill, and a floor that painted a sliver would be the renderer claiming
 * progress the view did not report.
 */
export const LOAD_PROGRESS_MIN = 0;

/**
 * The ceiling. The fraction crosses a boundary this window does not own, and a value
 * past one would paint a fill wider than its track and hand an assistive technology a
 * percentage above a hundred.
 */
export const LOAD_PROGRESS_MAX = 1;
