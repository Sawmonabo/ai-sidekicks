// The console's type system — the faces, the size scale, and the OpenType
// features every line is set with.
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
 * The OpenType features every line of the console is set with.
 *
 * `Spec-023 §Console Design (Meridian)` §Type and figures asks for the slashed
 * zero and tabular figures, and both are the reason a wire figure is legible: an
 * unslashed zero beside a capital O in a SHA is a reading error, and proportional
 * digits make two stacked costs fail to line up on their decimal point.
 *
 * Declared once and applied on `body` rather than on the mono token, because
 * `font-feature-settings` INHERITS — one declaration reaches every descendant,
 * including the mono spans, and a per-surface copy would be a second home for a
 * decision that has one. On a face without these features the declaration is
 * inert, which is what makes it safe to state at the root.
 */
export const TYPEFACE_FEATURE_SETTINGS = '"zero" 1, "tnum" 1';

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
 * (`Spec-023 §Console Libraries`, the motion/fonts/icons row), and the console
 * now self-hosts them: `frame/bindings/typeface.ts` declares six `@font-face` rules over
 * the foundry packages' own Latin-1 subsets, admitted as a distributed OFL-1.1
 * dependency by ADR-020's Decision Log. The platform fallbacks stay, and they are
 * not decoration — each face carries a `unicode-range`, so a codepoint outside
 * Latin-1 falls through to them rather than rendering as a notdef box.
 *
 * These two constants did not move when the faces arrived, which was the point of
 * naming the families here before anything loaded them: the stack is the design's
 * statement of what the console is set in, and the sheet is how those bytes get
 * to the document.
 *
 * THE FACES THIS REVISION SHIPS ARE STATIC, AND THE LIBRARIES ROW DESCRIBES
 * VARIABLE ONES. `@ibm/plex-sans@1.1.0` and `@ibm/plex-mono@2.5.0` publish static
 * instances only — no variable file under any name — so the sheet declares one
 * face per weight, and an intermediate weight resolves to the nearest declared
 * face rather than being interpolated.
 *
 * That is a property of the packages PINNED here rather than of the foundry: the
 * variable builds are published as their own packages, `@ibm/plex-sans-variable`
 * and `@ibm/plex-mono-variable`, which this revision does not take. Which pair
 * belongs here is a decision with a measurement behind it — the six static
 * subsets weigh 118,488 B raw against the two variable subsets the libraries row
 * cites — and it is the amendment's rather than this comment's to make; what this
 * comment must not do is read the absence of a variable file inside these two
 * packages as the absence of one anywhere.
 */
export const FONT_STACKS: Readonly<Record<string, string>> = {
  "font-sans":
    '"IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  "font-mono":
    '"IBM Plex Mono", ui-monospace, "SF Mono", "Cascadia Mono", "Roboto Mono", monospace',
};
