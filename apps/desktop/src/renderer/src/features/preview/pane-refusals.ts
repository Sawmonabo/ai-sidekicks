// The refusal codes this pane authors, as a closed set rather than as free strings.
//
// Every code below names something the RENDERER decided: a control pressed with nothing
// to act on, a destination this field does not take, a hand-off that did not go through.
// None of them is the daemon's: a refusal off the wire keeps the code the other side
// sent, `act-sequence.ts` normalizes it through the console's one reader, and nothing
// here paraphrases it. So this is a vocabulary with exactly one author, and a
// vocabulary with one author is a set that can be closed: one more code cannot be
// minted at a call site without this list, and so without a reviewer, noticing.
//
// `geometry/view-host.ts` carries its own set and its own origin, because a refusal's
// origin is what tells a person which subsystem authored the sentence.

import type { RejectionFallback } from "@renderer/lib/wire-rejection.js";

/** Every refusal code the browser pane authors or renders as its own. */
export const BROWSER_PANE_REFUSAL_CODES: readonly [
  "no-selected-page",
  "no-current-page",
  "filesystem-destination",
  "open-external-failed",
] = [
  // The pane's own controls, each refused before anything is dispatched.
  "no-selected-page",
  "no-current-page",
  "filesystem-destination",
  "open-external-failed",
];

/** One code this pane may refuse with. Derived, so the set has exactly one home. */
export type BrowserPaneRefusalCode = (typeof BROWSER_PANE_REFUSAL_CODES)[number];

/**
 * A rejection fallback whose code is one of this pane's own.
 *
 * The narrowing is what makes the set enforceable at the DECLARATION rather than at
 * the call: a fallback annotated with this type and carrying an unlisted code is a
 * compile error where it is written, which is where the author is.
 */
export type BrowserPaneRejectionFallback = RejectionFallback & {
  readonly code: BrowserPaneRefusalCode;
};
