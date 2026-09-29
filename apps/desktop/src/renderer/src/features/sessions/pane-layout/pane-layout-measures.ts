// The workspace's named figures that are not ceilings: the density presets and their pane
// widths, and the visibility threshold a native view hides at.
//
// THE CEILING IS NOT HERE. The restored-pane cap is a bound, and bounds are declared in
// `core/constants/` and read through the core door, so the cap lives there and this
// module holds only the figures that are not bounds.
//
// The density axis travels with its widths: the width table is a total `Record` keyed by the
// preset union, so a module holding the widths and importing the union from the module that
// imports the widths would be a cycle. `deck/model/density.ts` keeps what reads these.

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
 * The hide threshold `deck/rect/rect-discipline.ts` states: a native view hides when either
 * dimension of the visible clip is below one pixel. One pixel rather than zero because
 * a sub-pixel clip is a view the compositor still composites and nobody can see — the
 * cost with none of the benefit.
 */
export const NATIVE_VIEW_MINIMUM_VISIBLE_PX = 1;
