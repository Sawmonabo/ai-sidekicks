// The console's glyph vocabulary — the NAMES, and the geometry every face is
// held to.
//
// `Spec-023 §Console Design (Meridian)` §Layout grammar asks for "a single-stroke
// set … plus our own signature glyphs for participants, runs, and provenance kinds
// in the same collection", and `§Console Libraries` admits the Tabler set through
// `unplugin-icons` at build time. Both halves of that pairing now ship: a name is
// drawn either by a Tabler face or by one of our own SVGs, and `primitives/
// glyph-faces.ts` is where each name's answer is written down, one line each.
//
// WHY THE NAMES LIVE HERE AND THE FACES LIVE ONE FAMILY UP. `tokens/` is below
// `primitives/` on the console DAG, so this module cannot import a component and
// therefore cannot hold the face map. It does not need to: what every family
// above needs from the glyph set is the closed NAME, and a surface that names a
// glyph should not be pulling a React component tree in to do it. The split is
// also what keeps the set closed — `GLYPH_FACES` is a `Record<GlyphName, …>`, so
// the compiler reports a name added here with no face beside it.
//
// Three rules hold the family together, and they are why a face is compiled
// through our own plugin rather than dropped in as markup:
//
//   1. **One geometry.** Every face is drawn inside a square box, stroked at
//      {@link GLYPH_STROKE_WIDTH} scaled to that box, with round caps and joins,
//      and never filled. A glyph that fills is a glyph that reads heavier than
//      its neighbours at 16 px, and the rail is the console's most-seen surface.
//      Tabler draws at a 24-unit box and a 2-unit stroke and puts those
//      attributes on the drawing elements, so the rule is APPLIED at compile
//      time — `vitest/icon-compilation.ts` strips what an icon set brought and
//      puts the family's own back on the root — rather than asked for.
//   2. **One vocabulary of parts.** Circles are drawn as two half-arcs, dots as a
//      zero-length segment under a round cap, containers as square-cornered
//      rectangles whose corners are softened by the join rather than by an `rx` —
//      so the corner radius scales with the stroke instead of drifting from it.
//      This rule is what decides a name's face: a Tabler icon built out of these
//      parts is borrowed, and one that softens a corner with an explicit radius
//      or draws a different picture stays ours.
//   3. **A closed name set.** {@link GlyphName} is {@link GLYPH_NAMES}' own
//      members, not `string`. A surface that wants a glyph the console does not
//      have adds it here, in the family, rather than reaching for an image —
//      which is what keeps "a coherent icon family, not a grab-bag" checkable
//      rather than aspirational.
//
// The set is deliberately small. Each name below is either a rail destination, a
// pane kind (`Spec-023 §Console Design (Meridian)` fixes those as a closed set), a
// sidebar section's entity kind, one of the five kinds of nothing, or a control
// verb the console actually offers. Nothing is here "in case".

/** The box the family's own faces are drawn in. Both axes; square by construction. */
export const GLYPH_VIEWBOX_SIZE = 16;

/**
 * Stroke width every glyph is drawn at, in {@link GLYPH_VIEWBOX_SIZE} units.
 *
 * A RATIO rather than a per-collection number: a borrowed face drawn in a larger
 * box carries this same share of that box, so the family reads as one weight at
 * 16 px whichever collection a face came from. `vitest/icon-compilation.ts` does
 * the arithmetic once, and `primitives/glyph-faces.test.ts` reads the ratio back
 * off every compiled face.
 */
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

/**
 * Beside a section heading, a disclosure summary, a refusal's leading alert, or a
 * pane head's control — every mark that sits INSIDE a frame rather than being the
 * thing the frame is about.
 *
 * This step in particular is a ratio and not a preference: 14 reads quiet against the
 * default's 16 at this stroke width, and a chrome size chosen in one family drifts
 * from the same size chosen in another. That drift is what it retired — three private
 * copies of `14`, two of which cited each other as their authority.
 */
export const GLYPH_SIZE_CHROME = 14;

/**
 * Every glyph the console can draw, in reading order: rail destinations, entity
 * and pane kinds, state marks, then control verbs and navigation.
 *
 * THE ORDER IS LOAD-BEARING. The gallery route walks this array and the
 * screenshot tier generates a case per entry, so a name added here is covered
 * without a second list being edited — and a name added anywhere but its own
 * group reads as a stranger in the gallery.
 *
 * WHAT EACH NAME IS DRAWN BY IS NOT WRITTEN HERE. `primitives/glyph-faces.ts`
 * holds that, one line per name with its reason, because this family sits below
 * `primitives/` and cannot see a component. What this array declares is that the
 * set is CLOSED; the face map's totality over it is what the compiler checks.
 */
export const GLYPH_NAMES = [
  // --- The top-level destinations (`Spec-023 §Console Design (Meridian)` §The
  // surface set) and the session workspace reached from the first of them.
  "sessions",
  "workspace",
  "settings",
  // --- Entity and pane kinds — the breadcrumb's kind glyph.
  "agent",
  "run",
  "approval",
  "artifact",
  "worktree",
  "repo",
  "channel",
  "timeline",
  "terminal",
  "browser",
  "workflow",
  "inspector",
  "diff",
  "member",
  "goal",
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

/**
 * Every glyph the console can draw. Closed on purpose — see rule 3 above — and
 * closed by construction, being exactly {@link GLYPH_NAMES}' members.
 */
export type GlyphName = (typeof GLYPH_NAMES)[number];

/**
 * Whether a string names a glyph in the family.
 *
 * The fail-closed-projection rule ("an unknown enum member renders as the explicit
 * unrecognized row or badge, never as a guess") applies to glyph names the moment a
 * surface maps a wire value onto one. A caller that cannot prove its name is in the
 * set asks here and renders the unrecognized shape when the answer is no, rather
 * than indexing the face map and drawing nothing.
 *
 * Reads the ARRAY rather than the face map's keys, which is what lets it live
 * below `primitives/` — and it is the same closed set either way, because the
 * face map is typed over exactly these names.
 */
export function isGlyphName(value: string): value is GlyphName {
  return (GLYPH_NAMES as readonly string[]).includes(value);
}
