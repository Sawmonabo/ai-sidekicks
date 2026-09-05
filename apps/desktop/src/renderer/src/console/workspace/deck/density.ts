// What the deck's density presets MEAN, over the bounds that declare them.
//
// THIS DECK'S OWN RULE, because no committed document states it: three density presets
// (comfortable, standard, compact) as minimum pane widths from the type scale, chosen
// in Settings › Appearance. A preset is therefore NOT a spacing theme and not a
// row-collapse state — it is one number per preset, the narrowest a pane may be
// squeezed to before the deck refuses to take more width from it.
//
// WHY A MINIMUM WIDTH AND NOT A SCALE FACTOR. The thing a person is choosing is how
// many panes fit side by side. A scale factor would express that indirectly and would
// interact with the browser's own font-size setting in a way nobody can predict; a
// floor is the property the layout math actually consults, so it is the property the
// preset names.
//
// The presets, their widths, and the default live in `workspace/workspace-bounds.ts`,
// which is this family's one home for a bound. What is here is the three readings of
// them: whether a persisted string names a preset, what one preset's floor is, and how
// many panes of it fit. This module is deliberately DOM-free and React-free — it is
// read by the layout class, by the deck's separator maths, and by a test that asserts
// the ordering, and none of those has a document.

import {
  DECK_DENSITIES,
  DECK_MINIMUM_PANE_WIDTH_PX,
  type DeckDensity,
} from "../workspace-bounds.js";

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
