// The refusal codes this pane authors, as a closed set rather than as free strings.
//
// WHY A SET AT ALL. Every code below names something the RENDERER decided — a call
// that never came back, a control pressed with nothing to act on, a destination this
// field does not take. None of them is the daemon's: a refusal off the wire keeps the
// code the other side sent, `act-sequence.ts` normalizes it through the console's one
// reader, and nothing here paraphrases it. So this is a vocabulary with exactly one
// author, and a vocabulary with one author is a set that can be closed.
//
// AND WHY IT WAS WORTH CLOSING. `refuseLocally` used to take `code: string`, and the
// fallbacks were bare object literals, so a fourteenth code could be minted at any
// call site and nothing anywhere would report it. The two pre-existing sets in this
// family — `keyboard-handback.ts` and `geometry/view-host.ts` — already had the shape;
// what was missing was the set covering everything else the pane says for itself.
//
// THE TWO PRE-EXISTING SETS ARE NOT FOLDED IN, and that is deliberate. Each carries
// its own origin, and a refusal's origin is what tells a person which subsystem
// authored the sentence: merging them would put one name on three authors. What the
// completeness case beside this module checks is that the codes those sets own are
// not ALSO members here, which is the drift a merge would hide.
//
// `bound-reached` IS A MEMBER, AND IT IS NOT MINTED HERE. The page cap refusal is
// composed by `bounds/bound-enforcement.ts`, and the create control renders it through
// `refuseLocally` — so it is a code this pane reports even though this pane did not
// author its sentence. Leaving it out would have meant either widening `refuseLocally`
// back to `string` for one call site or re-spelling the constant at that site. It is
// listed once here and held to the bounds module's own constant by the case beside
// this file, so the two homes cannot drift.

import type { RejectionFallback } from "../../core/index.js";
import { BROWSER_BOUND_REFUSAL_CODE } from "../bounds/bound-enforcement.js";

/**
 * Every refusal code the browser pane authors or renders as its own.
 *
 * Ordered by where a person meets them: the acts, the pane's own controls, the two
 * subscriptions, the handback's publishes, the composer entry, and the one bound this
 * renderer spends.
 *
 * Written as an annotated tuple rather than `as const`, on the
 * `FIXTURE_SERVED_GROWTH_OPERATION_IDS` precedent: `isolatedDeclarations` cannot infer
 * an array carrying an identifier, so the bounds module's constant reaches the
 * annotation as `typeof BROWSER_BOUND_REFUSAL_CODE`. It is named in one place and
 * referenced in the other, and the compiler holds the two to each other.
 */
export const BROWSER_PANE_REFUSAL_CODES: readonly [
  "navigation-call-failed",
  "chrome-call-failed",
  "no-session",
  "no-selected-page",
  "no-current-page",
  "filesystem-destination",
  "open-external-failed",
  "navigation-subscription-failed",
  "page-subscription-failed",
  "handback-subscription-failed",
  "chord-mirror-publish-failed",
  "pane-attach-failed",
  "no-focused-pane",
  typeof BROWSER_BOUND_REFUSAL_CODE,
] = [
  // The two act fallbacks — a call that crossed the boundary and never came back,
  // split where the sentence stops being true (see `chrome/chrome-acts.ts`).
  "navigation-call-failed",
  "chrome-call-failed",
  // The pane's own controls, each refused before anything is dispatched.
  "no-session",
  "no-selected-page",
  "no-current-page",
  "filesystem-destination",
  "open-external-failed",
  // The two long-lived reads, refused where the subscription itself failed.
  "navigation-subscription-failed",
  "page-subscription-failed",
  // The handback's two publishes, which fail independently of each other.
  "handback-subscription-failed",
  "chord-mirror-publish-failed",
  // The composer's attach entry, from the menu rather than from the pane's chrome.
  "pane-attach-failed",
  "no-focused-pane",
  // The one ceiling this renderer is in a position to spend. Authored in
  // `bounds/bound-enforcement.ts`; rendered here.
  BROWSER_BOUND_REFUSAL_CODE,
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
