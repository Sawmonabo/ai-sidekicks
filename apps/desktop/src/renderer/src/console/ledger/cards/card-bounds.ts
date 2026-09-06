// The ledger cards' named figures that are not ceilings.
//
// THE CEILINGS ARE NOT HERE, and the reason is a gate rather than a preference:
// `test/console/architecture/cap-constant-home.test.ts` names `core/constants.ts` the
// one module a bound may be DECLARED in and fails a view family that declares one of
// its own, so the seven this module held — the two cache byte caps, the highlight and
// worker thresholds, the footnote registry's cap, the tool summary's, and the ANSI
// span cap — are declared there and read through the core door, each carrying the
// rationale it was written with.
//
// What stays is what that gate's own line separates from a ceiling: a figure nothing
// is checked against. A number that appears inline in this subtree and is not a layout
// literal is still a review rejection — the rationale is the point, not the constant.

/**
 * Complete blocks held back from the settled set, behind the incomplete tail.
 *
 * `Spec-023 §Console Libraries`, streaming-markdown row: "settled blocks parse once
 * with a two-block settle lag". Two, because a block boundary is not final when it is first
 * seen — a blank line after a paragraph becomes the inside of a list the moment the
 * next line starts with a marker, and a setext underline turns the paragraph above it
 * into a heading. One block of lag closes the setext case and not the list case; two
 * closes both, and a third would only delay memoisation without closing anything the
 * commonmark block grammar can still reinterpret.
 */
export const MARKDOWN_SETTLE_LAG_BLOCKS = 2;
