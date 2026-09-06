// The workspace's named bounds — one home, beside the code that spends them.
//
// `core/constants.ts` states the rule this module exists for: it "is that place for
// the substrate's domains; each view family adds its own module beside its subtree
// rather than widening this one, so a bound always sits next to the code that spends
// it". This family had four homes and no module — a cap in the deck's density table,
// one in its rect discipline, two in the sidebar's grammar, and one that had been put
// in `core/constants.ts` itself, against that file's own sentence.
//
// `Spec-023 §Console Design (Meridian)` §The four bars, "Light on the machine": "Every
// cap, window, and timeout is a named constant with a one-line rationale". The
// rationale is the point, so each one carries the derivation a later reader would
// otherwise have to guess at.
//
// THE DENSITY AXIS TRAVELS WITH ITS WIDTHS, and that is a decision rather than a
// convenience. The width table is a total `Record` keyed by the preset union, so the
// union is part of the bound: a module holding the widths and importing the union
// from the module that imports the widths is a cycle, which `structure:layering`
// fails. What stays in `deck/density.ts` is what READS these — the predicate, the
// lookup, and the how-many-fit arithmetic.

/**
 * Panes one saved deck layout may restore.
 *
 * This family's own decision, like the third of the three restore rules
 * `deck/deck-snapshot.ts` states — no committed document fixes the number, and the cap
 * is about untrusted input rather than performance: a persisted record is a file on
 * disk, and without a bound a corrupted or hand-edited one mounts panes until the
 * window stops responding. Twelve is past any arrangement a person builds on a display
 * the density presets below are drawn for, so the cap binds a defect and never a
 * session.
 */
export const DECK_RESTORED_PANE_CAP = 12;

/**
 * The deck's density presets, widest first.
 *
 * Closed, and declared exactly once: the union below is derived from this tuple rather
 * than written beside it, because two hand-kept copies of a closed set drift in the
 * direction nothing catches — a preset added to the union alone would have no width,
 * and the width lookup would answer `undefined` at a type that says it cannot.
 *
 * Order is presentation order: Settings renders them in this sequence, and it runs
 * loosest to tightest because that is how the control reads as a single axis.
 */
export const DECK_DENSITIES = ["comfortable", "standard", "compact"] as const;

/** One density preset. Derived from the enumeration, never restated. */
export type DeckDensity = (typeof DECK_DENSITIES)[number];

/**
 * What a new deck runs at, and what a restored snapshot falls back to.
 *
 * This family's own default, stated with the presets it chooses between: new panes
 * open at the standard preset.
 */
export const DEFAULT_DECK_DENSITY: DeckDensity = "standard";

/**
 * The narrowest a pane may be squeezed to, per preset, in CSS pixels.
 *
 * THE NUMBERS COME OFF THE TYPE SCALE, NOT OUT OF THE AIR. `tokens/palette.ts` sets
 * body text at `text-md` = 0.875 rem, which is 14 px at the 16 px root. A pane's
 * content column is legible at roughly 32 characters and comfortable at roughly 52; at
 * this face's average advance of about 7.2 px that is ~230 px and ~375 px, and each
 * preset adds the pane's own chrome (a 1 px boundary plus `space-3` of padding on each
 * side, 24 px). The three values are those sums rounded to the 4 px spacing base.
 * Stated so the next person moves them by re-deriving rather than by taste.
 *
 * A total `Record` keyed by the derived union, so a fourth preset is a compile error
 * here until its width is decided — a preset whose width defaulted silently would be a
 * preset that does nothing.
 */
export const DECK_MINIMUM_PANE_WIDTH_PX: Readonly<Record<DeckDensity, number>> = {
  // ~52 characters of body text plus the pane's chrome. One pane fills a laptop
  // half; two fill a wide external display.
  comfortable: 400,
  // ~44 characters plus chrome. Three panes on a 1440-point display, which is the
  // arrangement the deck is designed around.
  standard: 340,
  // ~32 characters plus chrome — the legibility floor. Below this the ledger's own
  // rows start wrapping mid-clause and the density stops buying anything.
  compact: 256,
};

/**
 * The smallest visible extent a native view is drawn at, in CSS pixels.
 *
 * The hide threshold `deck/rect-discipline.ts` states: a native view hides when either
 * dimension of the visible clip is below one pixel. One pixel rather than zero because
 * a sub-pixel clip is a view the compositor still composites and nobody can see — the
 * cost with none of the benefit.
 */
export const NATIVE_VIEW_MINIMUM_VISIBLE_PX = 1;

/**
 * The narrowest the sidebar may be kept at, in percent.
 *
 * Below this the section headers wrap and the column stops being readable at the type
 * scale, which is the same floor the collapsed rail exists to get back from — a
 * sidebar narrower than this is one a person would have collapsed on purpose.
 */
export const SIDEBAR_MINIMUM_WIDTH_PERCENT = 12;

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
 * The narrowest the deck may be squeezed to by a sidebar drag, in percent.
 *
 * THE COMPLEMENT OF {@link SIDEBAR_MAXIMUM_WIDTH_PERCENT}, NOT A SECOND CHOICE. The
 * workspace held its own `DECK_MINIMUM_WIDTH_PERCENT = 40` beside the split, and the
 * two readings did not agree: a forty-percent deck floor admits a sixty-percent
 * sidebar, while the clamp on the sidebar's record caps it at forty. One band, one
 * home, and the deck's end computed from the sidebar's so the pair cannot drift.
 */
export const DECK_MINIMUM_WIDTH_PERCENT: number = 100 - SIDEBAR_MAXIMUM_WIDTH_PERCENT;

/**
 * How wide the sidebar opens the first time, as a share of the workspace.
 *
 * Twenty-two percent is a column wide enough for a section's own rows at the type
 * scale and narrow enough that a two-pane deck still clears the deck's own density
 * floor on a 1280 px window.
 */
export const SIDEBAR_DEFAULT_WIDTH_PERCENT = 22;

/**
 * The width a collapsed sidebar occupies, in pixels.
 *
 * Not zero: the collapsed rail carries the control that expands it again, and a
 * sidebar collapsed to nothing is a sidebar a pointer cannot get back.
 */
export const SIDEBAR_COLLAPSED_WIDTH_PX = 40;
