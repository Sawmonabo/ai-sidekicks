// The two moments of a reveal as one component mounted on both sides of it. It renders nothing:
// the mechanism is React's effect ordering, which needs a position in the tree, not a node.
//
// On the reveal commit React destroys the deleted subtree's layout effects before detaching its
// nodes, then runs the inserted subtree's layout effects, so the reserved half records a focus
// that is still real and the loaded half restores against the new body. Neither half runs on a
// warm mount, and a suspended subtree's effects do not run until it is visible.

import { useLayoutEffect } from "react";

import { useOwnerWindow } from "#renderer/hooks/owner-window/useOwnerWindow.js";

import { type RevealFocusTransfer } from "./reveal-focus-transfer.js";

/** Props for `LazyBodyFocusTransfer`. */
export interface LazyBodyFocusTransferProps {
  /** The one mount's record, written by the reserved side and read by the loaded one. */
  readonly handoff: RevealFocusTransfer;
  /** Which side of the reveal this instance is standing on. */
  readonly phase: "reserved" | "revealed";
}

/** Carries this mount's focus across its own reveal, from whichever side it is mounted on. */
export function LazyBodyFocusTransfer(props: LazyBodyFocusTransferProps): React.JSX.Element {
  const { handoff, phase } = props;
  const ownerDocument = useOwnerWindow().document;
  useLayoutEffect(() => {
    if (phase === "revealed") {
      handoff.restoreAfterReveal();
      return undefined;
    }
    return () => {
      handoff.recordReservedFocus(ownerDocument);
    };
  }, [handoff, ownerDocument, phase]);
  return <></>;
}
