// What a pane-scoped value is a fact ABOUT, and the comparison that says so.
//
// A component instance outlives both of the things that decide what it is showing.
// React reuses the instance across a prop change, so a deck that swaps which pane a
// slot holds — or a window that hands the tree a different bridge — leaves every
// value the pane carried between renders describing a subject it has left. That is
// not a stale render: a draft typed for one pane submits to another, a history
// control enabled by one pane's reading dispatches against another's, and a
// rectangle published for one host reaches a host that has been retired.
//
// The family's answer everywhere is the same shape, and this module is that shape
// declared once: a value travels stamped with the `(bridge, paneId)` it was produced
// under, and the COMPARISON HAPPENS DURING RENDER. An effect that reset the state
// after the commit is one pass too late — the pass that renders the control is the
// pass a person can act on — so the mismatched value is suppressed on the way out
// rather than corrected on the way back.
//
// A MODULE RATHER THAN A THIRD COPY OF ONE `&&`. Three surfaces stamp against this
// pair — the navigation reading, the address field, and the geometry binding — and
// `apps/desktop/AGENTS.md` hoists a helper on its second use. All three consume this
// one, so "the same subject" cannot come to mean three things. It lives in `browser/`
// rather than in `panes/browser/` because the browser family is the lower of the two
// and the pane directory imports it, never the reverse.

import type { ConsoleBridge } from "../bridge/index.js";

/**
 * The pair a pane-scoped value belongs to.
 *
 * Both members, because both decide where an act goes: every pane-keyed call is made
 * on ONE bridge with ONE `paneId`, so a value produced under either of the other
 * combinations is not a value for this one.
 */
export interface PaneSubject {
  readonly bridge: ConsoleBridge;
  readonly paneId: string;
}

/**
 * Whether a stamped value is a fact about the subject this render is for.
 *
 * Reference identity on the bridge rather than a field off it: the bridge IS the
 * window's identity here, two bridges built over one preload contract are two
 * windows, and there is no member on it that says which.
 */
export function isCurrentPaneSubject(stamped: PaneSubject, subject: PaneSubject): boolean {
  return stamped.bridge === subject.bridge && stamped.paneId === subject.paneId;
}
