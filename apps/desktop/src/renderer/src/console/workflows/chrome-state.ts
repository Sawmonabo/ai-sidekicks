// What a workflows chrome is showing, as one closed set.
//
// Three surfaces in this family — the definitions browser, the run view, the
// node-graph builder — each answer the same question before they answer their own:
// is there anything here yet, and if not, WHICH kind of nothing is it? The design
// sections give the three the same vocabulary (`Spec-023 §Console Design (Meridian)`
// rule 8 and rule 9), so the vocabulary is declared once here and the three consume
// it, rather than each growing its own arm set that agrees until one of them grows
// a sixth.
//
// WHY THIS IS NOT `NothingKind`. Two of the arms below are not absences. `ready`
// says a body is mounted, and `refused` carries a daemon refusal, which rule 9
// gives its own grammar — a code in mono and the daemon's message verbatim — rather
// than the prose-plus-glyph shape an absence takes. Mapping `refused` onto the
// `error` absence would lose the code, and mapping `ready` onto anything would be a
// category error. What this set DOES is decide which of those two grammars a chrome
// reaches for, and the mapping to `NothingKind` for the three arms that are
// absences lives in `WorkflowChrome.tsx`, where the rendering does.
//
// THE `not-checked` ARM IS THE HONEST DEFAULT AND NOT A PLACEHOLDER. A workflows
// surface whose read has not been performed in this window has not learned that
// there is nothing; it has learned nothing. Rendering that as `empty` would be the
// console asserting a fact about the daemon's state that it never established,
// which is precisely the conflation the five kinds of nothing exist to prevent.

import type { ConsoleRefusal } from "../core/index.js";

/**
 * Every state a workflows chrome can be in, in the order a surface moves through
 * them: nobody asked, the read is in flight, the read found none, the daemon
 * refused, a body is mounted.
 *
 * The tuple is the declaration and the union's discriminant is derived from it, for
 * `frame/surface-registry.ts`'s reason: a union written beside a hand-repeated array
 * is two closed sets that agree until someone widens one, and the compiler sees
 * neither drift.
 */
export const WORKFLOW_CHROME_STATES = [
  "not-checked",
  "not-loaded",
  "empty",
  "refused",
  "ready",
] as const;

/** One chrome state's discriminant. Derived from the enumeration, never restated. */
export type WorkflowChromeStateKind = (typeof WORKFLOW_CHROME_STATES)[number];

/**
 * What a workflows chrome is showing.
 *
 * Copy travels ON the state rather than being looked up from the kind, because the
 * three surfaces are absent about different things — no definitions, no runs, no
 * phases — and a shared lookup table would either say something vague enough to fit
 * all three or grow a per-surface branch, which is the same table with extra steps.
 */
export type WorkflowChromeState =
  | {
      readonly kind: "not-checked";
      /** What was not asked, in one sentence. */
      readonly title: string;
      /** Where the answer does come from, so the absence names a next move. */
      readonly detail: string;
    }
  | { readonly kind: "not-loaded"; readonly title: string }
  | { readonly kind: "empty"; readonly title: string; readonly detail: string }
  | { readonly kind: "refused"; readonly refusal: ConsoleRefusal }
  | { readonly kind: "ready" };

/**
 * The state of a surface that has a subject and no answer for it yet.
 *
 * A named constructor rather than an object literal at each site: both panes reach
 * for this arm, and each would otherwise spell the discriminant itself — which is
 * how a third surface ends up spelling `notChecked` and rendering nothing at all.
 *
 * `not-checked` and never `empty` is the whole point of the helper. A surface that
 * has not performed its read has learned nothing, and rendering that as `empty`
 * would be the console asserting a fact about the daemon's state it never
 * established. The `empty` arm belongs to a surface whose read came back with none,
 * or whose address names no subject at all — a different next move, decided by the
 * caller that knows which of the two it is in.
 */
export function unaskedWorkflowChrome(title: string, detail: string): WorkflowChromeState {
  return { kind: "not-checked", title, detail };
}

/**
 * The state of a chrome the daemon refused.
 *
 * Takes the refusal whole rather than its two rendered fields, so the value that
 * arrives from a bridge call is the value that reaches the renderer — `origin`
 * included, which rule 9 keeps off the screen and the diagnostic band keeps.
 */
export function refusedWorkflowChrome(refusal: ConsoleRefusal): WorkflowChromeState {
  return { kind: "refused", refusal };
}
