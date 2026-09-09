// The workspace chrome's bounds: the cast bar's chip fold, the sidebar's width
// ceiling, the deck's restored pane cap, and the load hairline's progress range.
//
// Four surfaces of one frame, and one of them is a RANGE — a floor and a ceiling that
// a clamp reads together, which is why that range keeps one home.

/**
 * Participant chips the cast bar shows before folding to "+N" (rule 7).
 *
 * The number is a decision `Spec-023 §Meridian, the design language` rule 7 already
 * fixed — "the cast bar shows up to eight chips, then `+N`" — and a bound re-derived
 * at the point of use is a bound that can come back different.
 */
export const CAST_BAR_CHIP_CAP = 8;

/**
 * The widest the sidebar may be kept at, in percent.
 *
 * DERIVED FROM THE DECK, not chosen for the sidebar: the deck is the side whose own
 * density floor is measured in pixels, and forty percent is the share that still
 * leaves a two-pane deck above its preset's minimum on the narrowest window the
 * presets are drawn for. So it is written here as the sidebar's ceiling and read from
 * here as the deck's floor, rather than declared twice at two ends of one band and
 * left to agree by inspection.
 */
export const SIDEBAR_MAXIMUM_WIDTH_PERCENT = 40;

/**
 * Panes one saved deck layout may restore.
 *
 * This family's own decision, like the third of the three restore rules
 * `workspace/deck/model/deck-snapshot.ts` states — no committed document fixes the
 * number, and the cap is about untrusted input rather than performance: a persisted
 * record is a file on disk, and without a bound a corrupted or hand-edited one mounts
 * panes until the window stops responding. Twelve is past any arrangement a person
 * builds on a display the density presets below are drawn for, so the cap binds a
 * defect and never a session.
 */
export const DECK_RESTORED_PANE_CAP = 12;

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
