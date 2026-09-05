// The console's signature glyph collection.
//
// `Spec-023 §Console Design (Meridian)` §Layout grammar asks for "a single-stroke
// set … plus our own signature glyphs for participants, runs, and provenance kinds
// in the same collection", and `§Console Libraries` admits the Tabler set through
// `unplugin-icons` at build time. This module is the OWN half of that pairing, and
// it is the half that ships first: the console's shape depends on a stable, closed
// icon vocabulary, and a build-time icon plugin is a bundler concern that can land
// later without moving a single call site — `Glyph` reads a path string out of a
// record either way.
//
// Three rules hold the family together, and they are the reason the paths are
// authored by hand rather than pasted from a set:
//
//   1. **One geometry.** Every path is drawn inside a 16x16 box with a 2 px inset,
//      stroked at 1.5 px with round caps and joins, and never filled. A glyph that
//      fills is a glyph that reads heavier than its neighbours at 16 px, and the
//      rail is the console's most-seen surface.
//   2. **One vocabulary of parts.** Circles are drawn as two half-arcs, dots as a
//      zero-length segment under a round cap, containers as square-cornered
//      rectangles whose corners are softened by the join rather than by an `rx` —
//      so the corner radius scales with the stroke instead of drifting from it.
//   3. **A closed name set.** `GlyphName` is the record's own keys, not `string`. A surface that
//      wants a glyph the console does not have adds it here, in the family, rather
//      than reaching for an image — which is what keeps "a coherent icon family,
//      not a grab-bag" checkable rather than aspirational.
//
// The set is deliberately small. Each name below is either a rail destination, a
// pane kind (`Spec-023 §Console Design (Meridian)` fixes those as a closed set), a
// sidebar section's entity kind, one of the five kinds of nothing, or a control
// verb the console actually offers. Nothing is here "in case".

/** The box every path is drawn in. Both axes; the glyph is square by construction. */
export const GLYPH_VIEWBOX_SIZE = 16;

/** Stroke width every glyph is drawn at, in viewBox units. */
export const GLYPH_STROKE_WIDTH = 1.5;

/** Rendered edge length when a caller names no size, in CSS pixels. */
export const GLYPH_DEFAULT_SIZE = 16;

// THE ICON SCALE, and why it is a token rather than a constant beside each caller.
//
// A glyph's rendered edge length is a decision of the design language, not of the
// surface that happens to draw one: tighten the console's icons by a pixel and every
// glyph in every family moves together or the set stops reading as one family. It had
// been re-declared once per component — eight copies across one family alone, four of
// them the literal `12` — so the tightening was eight edits with nothing failing when
// seven were made.
//
// Three steps, named for the density they belong to rather than for the caller that
// spends them, so a second caller at the same density reads its own name in the
// import. Every step is strictly below `GLYPH_DEFAULT_SIZE`: a glyph inside a row, a
// chip, or a piece of chrome is subordinate to the text it sits beside, and the
// default is the standalone size. `tokens/glyphs.test.ts` asserts both properties, so
// a fourth step added out of order fails rather than silently inverting the scale.

/** Inside a dense gutter or a numeric column — the smallest step the set reads at. */
export const GLYPH_SIZE_DENSE = 10;

/** Inside a row, a chip, a toolbar toggle, or a card's leading mark. */
export const GLYPH_SIZE_ROW = 12;

/** Beside a section heading, a disclosure summary, or a gate's own chrome. */
export const GLYPH_SIZE_CHROME = 14;

/**
 * The path data, keyed by name. One `d` string per glyph — no groups, no fills, no
 * per-glyph stroke overrides, because a family whose members each carry their own
 * rendering options is not a family.
 *
 * This record is also the family's NAME declaration: `GlyphName` is derived from its
 * keys rather than written beside it as a union. The two used to be authored
 * separately, which is two closed sets that agree only while someone keeps them in
 * step — and the compiler cannot see the drift, because the record's key type was
 * the union, so the union was checked against itself.
 *
 * Declared in reading order: rail destinations, entity and pane kinds, state marks,
 * then control verbs and navigation. `GLYPH_NAMES` preserves that order.
 */
export const GLYPH_PATHS = {
  // --- The top-level destinations (`Spec-023 §Console Design (Meridian)` §The
  // surface set) and the session workspace reached from the first of them.
  // Stacked layers: a session is a stack of work, and the rail's first
  // destination is the stack of them.
  sessions: "M8 2 13.5 5 8 8 2.5 5ZM2.5 8 8 11l5.5-3M2.5 11 8 14l5.5-3",
  // A folder: the session workspace is a checkout on disk, not an abstraction.
  // Not a rail destination — the rail's middle one is `workflows`, which draws the
  // `workflow` glyph below — but the kind glyph the workspace surface and its
  // breadcrumb carry.
  workspace:
    "M2.5 12.5V4a.5.5 0 0 1 .5-.5h3.25l1.5 2h5.75a.5.5 0 0 1 .5.5v6.5a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5Z",
  // Sliders rather than a gear: settings here are values a person moves, and the
  // gear is the most-borrowed icon in the category the zero-copy bar guards.
  settings:
    "M2.5 5.25h2.75M8.25 5.25h5.25M2.5 10.75h5.25M11.25 10.75h2.25M5.25 5.25a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M8.25 10.75a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0",
  // --- Entity and pane kinds — the breadcrumb's kind glyph.
  // A hexagon with a mind at its centre. Deliberately NOT a face or a robot: a
  // sidekick is a participant, and the console's copy never anthropomorphises one.
  // The hexagon reads against `member`'s circle, which is the distinction that
  // matters on the cast bar.
  agent:
    "M8 2.25 13 5.15v5.7L8 13.75 3 10.85V5.15ZM6.75 8a1.25 1.25 0 1 0 2.5 0a1.25 1.25 0 1 0-2.5 0",
  // An activity trace: a run is a stretch of work with a shape, not a state badge.
  run: "M2.25 8h2.5l1.75-4.25 2.75 8.5 1.75-4.25h2.75",
  // A shield: an approval is an authorization, and the shield is the one shape in
  // the family that reads as "a rule was applied" rather than "a thing exists".
  approval: "M8 2.25 13 4.15v3.7c0 3-2.2 4.9-5 5.6-2.8-.7-5-2.6-5-5.6V4.15Z",
  artifact: "M4 2.25h4.75L12 5.5v8.25H4ZM8.75 2.25V5.5H12",
  // The git branch, drawn as it is drawn everywhere, because a worktree is exactly
  // the thing that picture already means to the people using this console.
  worktree:
    "M4 3.25a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M4 12.75a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M10 6.25a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M5.5 4.75v6.5M5.5 9.5h1.25a3.25 3.25 0 0 0 3.25-3.25",
  // A closed book. Deliberately not the panel-with-a-spine shape that would read
  // against `inspector`, and not a box, which would read against `browser`.
  repo: "M12.75 2.75H5.5A1.75 1.75 0 0 0 3.75 4.5v7A1.75 1.75 0 0 1 5.5 9.75h7.25ZM12.75 9.75v3.5H5.5a1.75 1.75 0 0 1 0-3.5",
  channel: "M6.25 2.5 4.75 13.5M11.25 2.5 9.75 13.5M2.75 6h10.5M2.25 10h10.5",
  // A left rail with rows hanging off it — the ledger, in miniature. The glyph is
  // a picture of the surface it opens, which is the cheapest form of legibility.
  timeline: "M3 2.75v10.5M5.75 4.5h7.5M5.75 8h5.25M5.75 11.5h6.75",
  terminal: "M2.25 3.25h11.5v9.5H2.25ZM5 6.25 7.25 8.5 5 10.75M9 10.75h3",
  browser: "M2.25 3.25h11.5v9.5H2.25ZM2.25 6.5h11.5M4.5 4.85h.01M6.5 4.85h.01M8.5 4.85h.01",
  workflow:
    "M2.5 2.75h4.25v3.5H2.5ZM9.25 9.75h4.25v3.5H9.25ZM4.625 6.25v3.75a1.5 1.5 0 0 0 1.5 1.5h3.125",
  inspector: "M2.25 3.25h11.5v9.5H2.25ZM9.25 3.25v9.5M10.5 6.25h2M10.5 8.5h2M10.5 10.75h1.25",
  diff: "M12.75 3.25 3.25 12.75M4.5 3.25v4M2.5 5.25h4M9.5 10.75h4",
  member: "M5.5 5.5a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0M3 13.5a5 5 0 0 1 10 0",
  goal: "M2.75 8a5.25 5.25 0 1 0 10.5 0a5.25 5.25 0 1 0-10.5 0M5.75 8a2.25 2.25 0 1 0 4.5 0a2.25 2.25 0 1 0-4.5 0M8 8h.01",
  // --- State marks.
  // Rule 8's "unknown, still computing" badge names a clock glyph in terms.
  clock: "M2.75 8a5.25 5.25 0 1 0 10.5 0a5.25 5.25 0 1 0-10.5 0M8 4.75V8l2.5 1.5",
  alert: "M8 2.5 14 13H2ZM8 6.5v3M8 11.5h.01",
  check: "M3.25 8.5 6.25 11.5l6.5-7",
  dot: "M5.5 8a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0",
  // Two chevrons closing onto a rule: the mark a compaction boundary carries. The
  // line is what the exchanges above and below it were folded down to, and the two
  // chevrons point AT it rather than away, because the boundary is where a
  // transcript got shorter and not where it was cut in two.
  fold: "M2.5 8h11M5 2.75 8 5.75 11 2.75M5 13.25 8 10.25 11 13.25",
  // --- Control verbs and navigation.
  search: "M2.75 7a4.25 4.25 0 1 0 8.5 0a4.25 4.25 0 1 0-8.5 0M10.25 10.25 13.5 13.5",
  close: "M4 4 12 12M12 4 4 12",
  "chevron-right": "M6.25 3.5 10.75 8l-4.5 4.5",
  "chevron-down": "M3.5 6.25 8 10.75l4.5-4.5",
  pause: "M6 3.75v8.5M10 3.75v8.5",
  play: "M5.5 3.5 12.25 8 5.5 12.5Z",
  stop: "M4 4h8v8H4Z",
  // A counter-clockwise arrow: rewind to an earlier turn. Drawn as an open ring
  // with the head on the arc's own start point rather than as a `play` mirrored,
  // because the verb is not "run the other way" — it is "put the conversation back
  // where it was", and the gap in the ring is the part being given up.
  rewind: "M6.66 4.33 4.82 4.82 5.31 2.99M4.82 4.82A4.5 4.5 0 1 1 3.5 8",
  copy: "M5.5 5.5h8v8h-8ZM10.5 5.5v-3h-8v8h3",
  pencil: "M11.25 2.5 13.5 4.75 5.5 12.75 2.5 13.5 3.25 10.5ZM9.75 4 12 6.25",
  external:
    "M12.75 9v3.25a1 1 0 0 1-1 1h-8.5a1 1 0 0 1-1-1v-8.5a1 1 0 0 1 1-1H7M9.75 2.75h3.5v3.5M13.25 2.75 7.5 8.5",
  more: "M3.75 8h.01M8 8h.01M12.25 8h.01",
  plus: "M8 3.5v9M3.5 8h9",
} as const;

/**
 * Every glyph the console can draw. Closed on purpose — see rule 3 above — and
 * closed by construction, being exactly the keys of the record it is drawn from.
 */
export type GlyphName = keyof typeof GLYPH_PATHS;

/**
 * Whether a string names a glyph in the family.
 *
 * The fail-closed-projection rule ("an unknown enum member renders as the explicit
 * unrecognized row or badge, never as a guess") applies to glyph names the moment a
 * surface maps a wire value onto one. A caller that cannot prove its name is in the
 * set asks here and renders the unrecognized shape when the answer is no, rather
 * than indexing the record and drawing an empty box.
 */
export function isGlyphName(value: string): value is GlyphName {
  return Object.prototype.hasOwnProperty.call(GLYPH_PATHS, value);
}

/**
 * Every glyph name, in declaration order. The gallery route walks this, and the
 * screenshot tier's per-glyph cases are generated from it, so a glyph added to the
 * record above is covered without a second list being edited.
 */
export const GLYPH_NAMES: readonly GlyphName[] = Object.keys(GLYPH_PATHS).filter(isGlyphName);
