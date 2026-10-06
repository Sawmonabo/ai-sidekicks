// The density presets and their pane widths.
// The restored-pane cap is declared beside the store that spends it (`store.ts`).
//
// The presets live with their widths because the width table is keyed by the preset union;
// `density.ts` holds what reads them and imports from here, not the reverse.

/** The pane layout's density presets, in order from loosest to tightest. */
export const PANE_LAYOUT_DENSITIES = ["comfortable", "standard", "compact"] as const;

/** One density preset. */
export type PaneLayoutDensity = (typeof PANE_LAYOUT_DENSITIES)[number];

/** What a new pane layout runs at, and what a restored snapshot falls back to. */
export const DEFAULT_PANE_LAYOUT_DENSITY: PaneLayoutDensity = "standard";

/**
 * The narrowest a pane may be squeezed to, per preset, in CSS pixels.
 *
 * Derived from the type scale: body text is `text-md` (14 px at the 16 px root), a legible
 * column is about 32 characters and a comfortable one about 52, at an average advance of about
 * 7.2 px, plus the pane's own chrome (a 1 px boundary and `space-3` of padding each side, 24 px),
 * rounded to the 4 px spacing base. Re-derive rather than adjust by taste.
 */
export const PANE_LAYOUT_MINIMUM_PANE_WIDTH_PX: Readonly<Record<PaneLayoutDensity, number>> = {
  // About 52 characters of body text plus the pane's chrome.
  comfortable: 400,
  // About 44 characters plus chrome; three panes on a 1440-point display.
  standard: 340,
  // About 32 characters plus chrome, the legibility floor.
  compact: 256,
};
