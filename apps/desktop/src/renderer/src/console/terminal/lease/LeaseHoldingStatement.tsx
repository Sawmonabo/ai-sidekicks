// What the lease is, from this window's seat, in words.
//
// Split from `LeaseLine.tsx` so that module declares one component. The arm ORDER is
// the content: `unrecognized-transition` is answered before the null-holder arm,
// because a fold that refused to guess and a wire that said nobody holds it produce
// the same null holder and opposite sentences, and rendering the free-lease line for
// the first is the one thing here that is certainly wrong.
//
// NO HOLDER IS NAMED, and that is the whole shape of this surface. The shell belongs to
// the one person using this machine, so a hold this window does not have is a hold one
// of their OTHER windows has — which is a fact about where the keyboard is and not
// about who somebody is. Naming an identifier here would be answering a question nobody
// asked with a value nobody can act on.

import { DerivedFigure } from "../../primitives/index.js";
import type { TerminalLeaseHolding } from "./lease-model.js";

export interface LeaseHoldingStatementProps {
  readonly holding: TerminalLeaseHolding;
}

export function LeaseHoldingStatement(props: LeaseHoldingStatementProps): React.JSX.Element {
  switch (props.holding) {
    case "not-checked":
      return <DerivedFigure text="The lease has not been read." />;
    // Before the unheld arm, which would otherwise render this state as the free
    // lease — the one sentence that is certainly wrong here. The holder is null
    // because the fold refused to guess, not because the wire said nobody holds it.
    case "unrecognized-transition":
      return <DerivedFigure text="The console cannot read where the shell is held." />;
    case "unheld":
      return <DerivedFigure text="Nobody holds the shell." />;
    case "held-by-you":
      return <DerivedFigure text="You may type into the shared shell." />;
    case "held-by-another":
      return <DerivedFigure text="The shell is held from another window." />;
  }
}
