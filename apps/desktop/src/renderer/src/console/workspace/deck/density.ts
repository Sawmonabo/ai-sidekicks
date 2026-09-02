// The deck's three density presets, expressed as minimum pane widths.
//
// `Spec-023 §Console Design (Meridian)` §4.2: "Three density presets
// (comfortable, standard, compact) as minimum pane widths from our type scale,
// chosen in Settings › Appearance". A preset is therefore NOT a spacing theme and
// not a row-collapse state — it is one number per preset, the narrowest a pane may
// be squeezed to before the deck refuses to take more width from it.
//
// WHY A MINIMUM WIDTH AND NOT A SCALE FACTOR. The thing a person is choosing is how
// many panes fit side by side. A scale factor would express that indirectly and
// would interact with the browser's own font-size setting in a way nobody can
// predict; a floor is the property the layout math actually consults, so it is the
// property the preset names.
//
// THE NUMBERS COME OFF THE TYPE SCALE, NOT OUT OF THE AIR. `tokens/palette.ts` sets
// body text at `text-md` = 0.875 rem, which is 14 px at the 16 px root. A pane's
// content column is legible at roughly 32 characters and comfortable at roughly 52;
// at this face's average advance of about 7.2 px that is ~230 px and ~375 px, and
// each preset adds the pane's own chrome (a 1 px boundary plus `space-3` of padding
// on each side, 24 px). The three values below are those sums rounded to the 4 px
// spacing base. Stated so the next person moves them by re-deriving rather than by
// taste.
//
// This module is deliberately DOM-free and React-free: it is read by the layout
// class, by the deck's separator maths, and by a test that asserts the ordering,
// and none of those has a document.

/**
 * The presets, widest first. Closed, and declared exactly once: the union below is
 * derived from this tuple rather than written beside it, because two hand-kept
 * copies of a closed set drift in the direction nothing catches — a preset added to
 * the union alone would have no width, and the width lookup would answer
 * `undefined` at a type that says it cannot.
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
 * `Spec-023 §Console Design (Meridian)` §4.2 fixes it in terms: "New panes open at
 * the standard preset".
 */
export const DEFAULT_DECK_DENSITY: DeckDensity = "standard";

/**
 * The narrowest a pane may be squeezed to, per preset, in CSS pixels.
 *
 * A total `Record` keyed by the derived union, so a fourth preset is a compile
 * error here until its width is decided — a preset whose width defaulted silently
 * would be a preset that does nothing.
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
 * Whether `value` names a preset.
 *
 * Takes `unknown` because the one caller that needs it is reading a persisted
 * layout snapshot, where the value came off disk and may predate or postdate this
 * build. A snapshot naming a preset this build does not have takes the default
 * rather than a hole.
 */
export function isDeckDensity(value: unknown): value is DeckDensity {
  return typeof value === "string" && (DECK_DENSITIES as readonly string[]).includes(value);
}

/** The floor for a preset. A lookup, so no caller indexes the record itself. */
export function minimumPaneWidthPx(density: DeckDensity): number {
  return DECK_MINIMUM_PANE_WIDTH_PX[density];
}

/**
 * How many panes of `density` fit in `availableWidthPx`, at least one.
 *
 * At least one because a deck that answered zero would have nowhere to put the pane
 * a person just opened, and a pane below its floor is a legibility problem the
 * person can fix by resizing the window — an invisible pane is not.
 */
export function panesThatFit(density: DeckDensity, availableWidthPx: number): number {
  return Math.max(1, Math.floor(availableWidthPx / minimumPaneWidthPx(density)));
}
