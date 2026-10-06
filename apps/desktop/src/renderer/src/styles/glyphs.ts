// The app's glyph vocabulary: the names, and the geometry every face is held to.
//
// A name is drawn either by a Tabler face (compiled at build time through `unplugin-icons`) or by
// one of our own SVGs, and `components/Glyph/icons.ts` records each name's answer. The names
// live here because `styles/` sits below `components/` in the import direction and cannot import
// a component. `GLYPH_ICONS` is a `Record<GlyphName, ...>`, so the compiler reports a name added
// here with no face.
//
// Three rules hold the set together, and they are why a face is compiled through our own plugin
// rather than dropped in as markup:
//
//   1. **One geometry.** Every face is drawn inside a square box, stroked at
//      {@link GLYPH_STROKE_WIDTH} scaled to that box, with round caps and joins, and never filled;
//      a filled glyph reads heavier at 16 px, and the rail is the most-seen chrome. Tabler draws
//      at a 24-unit box and a 2-unit stroke on the drawing elements, so the rule is applied at
//      compile time: `vitest/icon-compilation.ts` strips what an icon set brought and puts the
//      set's own back on the root.
//   2. **One vocabulary of parts.** Circles are two half-arcs, dots a zero-length segment under a
//      round cap, and containers square-cornered rectangles softened by the join rather than an
//      `rx`, so the corner radius scales with the stroke. This decides a name's face: a Tabler
//      icon built of these parts is borrowed, and one that softens a corner with an explicit
//      radius or draws a different picture stays ours.
//   3. **A closed name set.** {@link GlyphName} is {@link GLYPH_NAMES}' own members, not `string`.
//      A component that wants a glyph the app lacks adds it to the set instead of reaching
//      for an image.
//
// The set stays small: each name is a rail destination, a pane kind, a sidebar section's entity
// kind, one of the five kinds of nothing, or a control verb the app offers.

/** The box the set's own faces are drawn in. Both axes; square by construction. */
export const GLYPH_VIEWBOX_SIZE = 16;

/**
 * Stroke width every glyph is drawn at, in {@link GLYPH_VIEWBOX_SIZE} units. A ratio rather than
 * a per-collection number: a borrowed face drawn in a larger box carries the same share of it, so
 * the set reads as one weight. `vitest/icon-compilation.ts` does the arithmetic.
 */
export const GLYPH_STROKE_WIDTH = 1.5;

/** Edge length when a caller names no size, in CSS pixels at every text size. */
export const GLYPH_DEFAULT_SIZE = 16;

// The icon scale is a token so that tightening the icons by a pixel moves every glyph together.
// The two steps are named for the density they belong to, and each is strictly below
// `GLYPH_DEFAULT_SIZE`, the standalone size, because a glyph inside a row, chip or chrome is
// subordinate to the text beside it.

/** Inside a row, a chip, a toolbar toggle, or a card's leading mark. */
export const GLYPH_SIZE_ROW = 12;

/**
 * Beside a section heading, a disclosure summary, a refusal's leading alert, or a pane head's
 * control: marks that sit inside a frame rather than being what the frame is about. 14 reads
 * quiet against the default's 16 at this stroke width.
 */
export const GLYPH_SIZE_CHROME = 14;

/**
 * Every glyph the app can draw, in reading order: rail destinations, entity and pane kinds,
 * state marks, then control verbs and navigation. Which face draws each name is in
 * `components/Glyph/icons.ts`; this array declares that the set is closed.
 */
export const GLYPH_NAMES = [
  // --- The rail destinations.
  "sessions",
  "settings",
  // --- Entity and pane kinds — the breadcrumb's kind glyph.
  "agent",
  "run",
  "approval",
  "artifact",
  "workspace",
  "worktree",
  "repo",
  "transcript",
  "terminal",
  "browser",
  "workflow",
  "inspector",
  "diff",
  // --- State marks.
  "clock",
  "alert",
  "check",
  "dot",
  "fold",
  // --- Control verbs and navigation.
  "search",
  "close",
  "chevron-right",
  "chevron-down",
  "pause",
  "play",
  "stop",
  "rewind",
  "copy",
  "pencil",
  "external",
  "more",
  "plus",
] as const;

/** Every glyph the app can draw: exactly {@link GLYPH_NAMES}' members. */
export type GlyphName = (typeof GLYPH_NAMES)[number];

/**
 * Whether a string names a glyph in the set. A view that maps a wire value onto a glyph renders
 * the unrecognized shape when this is false, rather than indexing the face map and drawing
 * nothing. Reads the array so it can live below `components/`.
 *
 * @consumedBy an agent definition's icon, read from its saved file
 */
export function isGlyphName(value: string): value is GlyphName {
  return (GLYPH_NAMES as readonly string[]).includes(value);
}
