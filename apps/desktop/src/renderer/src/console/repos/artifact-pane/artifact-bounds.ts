// The artifact pane's named bounds.
//
// `console/core/constants.ts` states the rule and the split: every cap, window, and
// timeout is a named constant with a one-line rationale, and "each view family adds
// its own module beside its subtree rather than widening this one, so a bound always
// sits next to the code that spends it". This is that module for the artifact pane,
// on `repos/diff-pane/diff-bounds.ts`'s precedent one directory over.
//
// The bound below sat in `core/constants.ts` until this module existed, inside a
// block whose preamble reads "Spec-014 §Bounds registers all four of the bounds below
// on the wire … Each mirrors its registered source EXACTLY" — which its own doc
// comment contradicted in the next breath, because it mirrors no wire at all. It is
// spent by exactly one family, which is the case that module's placement rule sends
// here.

/**
 * Characters of a fetched artifact payload the pane will draw at once.
 *
 * A RENDERER bound and not a wire one, so it is picked here rather than mirrored
 * from a contract: an inline payload arrives whole and the pane has to decide how
 * much of it a person is shown before scrolling a hundred-megabyte log becomes the
 * surface's whole cost. Two thousand characters is a screenful and a half at the
 * console's mono measure — enough to recognise what a payload IS, which is what the
 * preview is for, and far short of the point where a single text node degrades
 * layout. Truncation is always reported beside the text; the preview never silently
 * shortens what it drew.
 */
export const ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP = 2_000;
