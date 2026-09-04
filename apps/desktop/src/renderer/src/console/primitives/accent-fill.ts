// The one filled-accent control face, named on the TypeScript side.
//
// `primitives.css` owns what the class DOES — the fill, its matching edge, its
// `accent-ink` label, and how it answers hover and press. This module owns its
// NAME, because the surfaces that wear it live outside this family (an approval's
// approve action and a goal's save), and a class name spelled at each call site is
// a string that drifts away from the sheet in silence: the rule stays green, the
// control quietly loses its face, and no gate reports it.
//
// The other half of the seam cannot be an import — a stylesheet imports nothing —
// so `test/console/architecture/accent-fill-pairing.test.ts` reads the sheet and
// asserts the selector this constant names is in it.

/**
 * The class a control wears to take the whole accent as its face, with
 * `accent-ink` as its label.
 *
 * It carries the fill and what a fill implies, and deliberately nothing about size:
 * a consumer keeps its own padding and type. Rule 1 puts ONE primary action on a
 * surface, so a surface that renders this twice is rendering one too many.
 */
export const ACCENT_FILL_CLASS = "meridian-accent-fill";
