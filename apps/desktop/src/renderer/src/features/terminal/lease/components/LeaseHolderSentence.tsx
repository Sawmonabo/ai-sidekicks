// What the lease is, from this device's point of view, in words. No holder is named: the shell
// belongs to one person, so a hold this device lacks is held by another of their devices.
// `unrecognized-transition` is answered before `unheld`: both have a null holder, and the free
// line is wrong for a fold that refused to guess.

import { DerivedFigure } from "@renderer/components/DerivedFigure/DerivedFigure.js";
import type { TerminalLeaseHolder } from "../lease-model.js";

/** The holding the statement words. */
export interface LeaseHolderSentenceProps {
  readonly holding: TerminalLeaseHolder;
}

/** One sentence saying where the shared shell is held. */
export function LeaseHolderSentence(props: LeaseHolderSentenceProps): React.JSX.Element {
  switch (props.holding) {
    case "not-checked":
      return <DerivedFigure text="The lease has not been read." />;
    case "unrecognized-transition":
      return <DerivedFigure text="The console cannot read where the shell is held." />;
    case "unheld":
      return <DerivedFigure text="Nobody holds the shell." />;
    case "held-by-this-device":
      return <DerivedFigure text="You may type into the shared shell." />;
    case "held-by-another-device":
      return <DerivedFigure text="The shell is held from another device." />;
    // The fold names no agent for a run's hold and this line has no stop action, so the
    // sentence carries neither.
    case "held-by-run":
      return <DerivedFigure text="Running command holds the shell." />;
  }
}
