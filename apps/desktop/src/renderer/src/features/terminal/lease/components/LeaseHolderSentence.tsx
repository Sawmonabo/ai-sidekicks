// Where the shell is held, in words, for the holders the lease line draws. No holder is named:
// the shell belongs to one person, so a hold this device lacks is held by another of their
// devices. `unrecognized-transition` has its own sentence, since its holder is unknown.

import { DerivedFigure } from "#renderer/components/DerivedFigure/DerivedFigure.js";
import type { DrawnLeaseHolder } from "../state.js";

/** The holder the statement words. */
export interface LeaseHolderSentenceProps {
  readonly holder: DrawnLeaseHolder;
}

/** One sentence saying where the shared shell is held. */
export function LeaseHolderSentence(props: LeaseHolderSentenceProps): React.JSX.Element {
  switch (props.holder) {
    case "unrecognized-transition":
      return <DerivedFigure text="The app cannot read where the shell is held." />;
    case "held-by-another-device":
      return <DerivedFigure text="The shell is held from another device." />;
    // The fold names no agent for a run's hold and this line has no stop action, so the
    // sentence carries neither.
    case "held-by-run":
      return <DerivedFigure text="Running command holds the shell." />;
  }
}
