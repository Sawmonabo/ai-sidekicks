// The console's type system — the faces the console asks for, the line height, and
// the size scale every line is set on.
//
// Split out of `palette.ts` rather than authored beside it, and the seam is the
// question each file answers. `palette.ts` answers "what colour is this?" — a
// system whose every value is measured against a contrast floor and whose tests
// are ratio tests. This file answers "how is text set?", which no contrast
// measurement touches. They were one file at 437 lines, past the point where a
// module is doing one job, and the sizes and faces were the half that had nothing
// to do with the colour tests reading the other half.
//
// Two modules read it, and the edge points one way in both cases. `generate-css.ts`
// composes this and the palette into the one emitted sheet, which is where the two
// systems meet. `palette.ts` reads the line height and the type scale for
// `ENUMERATION_ROW_HEIGHT_REM`, which is a product of both scales — a row is a line
// box plus its padding — so this file stays a LEAF that imports nothing local and
// the dependency cannot become a cycle.
//
// `Spec-023 §Console Design (Meridian)` rule 4 governs everything here: UI text in
// a humanist grotesque, every wire-true figure in mono, and the two set on one
// shared scale so a figure and its label sit on the same baseline.
//
// WHERE THE OPENTYPE FEATURES ARE NOT, AND WHY. Rule 4 asks for a slashed zero and
// tabular figures, and this file declares neither.
//
//   The SLASHED ZERO belongs to the mono FACE and is declared as a descriptor
//   inside its two `@font-face` rules in `frame/bindings/typeface.ts`. It was on
//   `body` here first, and that was the wrong home twice over: rule 4 makes mono
//   the signature that a number came from the wire, and `font-feature-settings`
//   INHERITS, so a root declaration slashed the zero in every participant name,
//   repo path, and branch name in the console — and then, because CSS Fonts 4
//   gives that property precedence over the features `font-variant-*` computes,
//   left no descendant able to scope the feature back.
//
//   TABULAR FIGURES need no feature at all in these faces. Read out of the shipped
//   `woff2` files on 2026-09-09: neither family carries `tnum` in `GSUB` or `GPOS`,
//   and neither carries `pnum` either, which is the reading that settles it — there
//   are no proportional figures to switch away FROM, and every digit in both
//   families measures 600/1000 em. The digits are tabular by construction, so
//   `"tnum" 1` would be a feature declared against a face that offers none. The two
//   sheets that set `font-variant-numeric: tabular-nums` state it for the platform
//   FALLBACK faces, which do offer both sets.

/**
 * The line height every body line box occupies, as a multiple of its own size.
 *
 * Named rather than written into the generator's `body` rule, because it is not
 * only a paint instruction: a row of any list is a line box plus its padding, so
 * the console's row rhythm is derived from this number and would silently stop
 * matching what the sheet paints if the two were written separately.
 */
export const BODY_LINE_HEIGHT = 1.5;

/**
 * Type scale, in rem. Rule 4 sets UI text in a humanist grotesque and every
 * wire-true figure in mono; the scale is shared so a figure and its label sit on
 * the same baseline.
 */
export const TYPE_SCALE_REM: Readonly<Record<string, number>> = {
  "text-xs": 0.6875,
  "text-sm": 0.8125,
  "text-md": 0.875,
  "text-lg": 1,
  "text-xl": 1.25,
};

/**
 * The font stacks. IBM Plex Sans and IBM Plex Mono are the ratified faces
 * (`Spec-023 §Console Design (Meridian)` rule 4 and `§Console Libraries`, the
 * motion/fonts/icons row), and the console self-hosts the VARIABLE builds those
 * two places name: `frame/bindings/typeface.ts` declares two `@font-face` rules per
 * family over `@ibm/plex-sans-variable` and `@ibm/plex-mono-variable` — the Roman
 * and Italic Latin-1 splits of each, so an italic run gets the italic the foundry
 * cut rather than a browser-slanted upright. What ships is the FONT FILES, admitted
 * as distributed OFL-1.1 assets by ADR-020's Decision Log; the two packages are
 * build-time-only `devDependencies`, because the bundler resolves those `?url`
 * imports while building and nothing resolves either specifier at runtime. The
 * platform fallbacks stay, and they are not decoration — each face carries a
 * `unicode-range`, so a codepoint outside Latin-1 falls through to them rather than
 * rendering as a notdef box.
 *
 * These two constants did not move when the faces arrived, which was the point of
 * naming the families here before anything loaded them: the stack is the design's
 * statement of what the console is set in, and the sheet is how those bytes get
 * to the document. They did not move when the faces became variable either, and
 * that is the same property holding: the family a rule ASKS for is this file's,
 * and which bytes answer is the other module's.
 *
 * WHAT VARIABLE BUYS, IN THIS CONSOLE, IS ONE WEIGHT. Every file carries a
 * continuous `wght 100–700` axis, so the 400, 500, and 600 the stylesheets ask for
 * and the 640 `palette/palette.css` asks for are each a real instance. Under the
 * static packages that preceded them there were three cuts per family and 640
 * silently became 600. The sans builds additionally carry `wdth 85–100`; nothing
 * here asks for a width today, and the declaration bounds it rather than using it.
 */
export const FONT_STACKS: Readonly<Record<string, string>> = {
  "font-sans":
    '"IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  "font-mono":
    '"IBM Plex Mono", ui-monospace, "SF Mono", "Cascadia Mono", "Roboto Mono", monospace',
};
