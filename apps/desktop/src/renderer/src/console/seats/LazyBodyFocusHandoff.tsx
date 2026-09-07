// The two moments of a reveal, as one component mounted on both sides of it.
//
// ONE COMPONENT AND NOT TWO, because the two halves are one claim written from either
// end: the reserved region records where the keyboard was as it goes, and the loaded body
// puts it back as it arrives. A second component would be a second place to read before
// either half made sense, and the pair would drift the first time one of them learned
// something the other did not.
//
// IT RENDERS NOTHING, WHICH IS WHAT LETS IT SIT ANYWHERE. A wrapper element inside a
// `Suspense` fallback would be a box in a layout the deck sizes, and the console already
// removed one adapter that had to declare `display: contents` to stop a deck seeing it.
// What this needs is not a node but a POSITION in the tree — the effect ordering React
// guarantees within one commit is the whole mechanism, and an effect needs no DOM.
//
// WHY THE ORDERING HOLDS. React destroys a deleted subtree's layout effects during the
// mutation phase, before its host nodes are detached, and runs an inserted subtree's
// layout effects afterwards in the layout phase. So on the reveal commit the reserved
// half records a focus that is still real, and the loaded half restores against a
// document that already holds the new body. Neither half is reached on a warm mount:
// `LazyBody` renders no fallback when the module is already in hand, and a suspended
// subtree's effects do not run until it becomes visible.

import { useLayoutEffect } from "react";

import { type RevealFocusHandoff } from "./lazy-body-focus.js";

export interface LazyBodyFocusHandoffProps {
  /** The one mount's record, written by the reserved side and read by the loaded one. */
  readonly handoff: RevealFocusHandoff;
  /** Which side of the reveal this instance is standing on. */
  readonly phase: "reserved" | "revealed";
}

/**
 * Carry this mount's focus across its own reveal, from whichever side it is mounted on.
 *
 * It renders an EMPTY FRAGMENT rather than `null`, which is the one shape that is both
 * true and legible: this is a component, it draws nothing, and a fragment says so in the
 * language the tree already reads — `one-component-per-module.test.ts` resolves a
 * component by the markup it renders or the element type it returns, and a module that
 * resolved neither would score clean against a rule that had never been applied to it.
 */
export function LazyBodyFocusHandoff(props: LazyBodyFocusHandoffProps): React.JSX.Element {
  const { handoff, phase } = props;
  useLayoutEffect(() => {
    if (phase === "revealed") {
      handoff.restoreAfterReveal();
      return undefined;
    }
    return () => {
      handoff.recordReservedFocus();
    };
  }, [handoff, phase]);
  return <></>;
}
