// Who holds the session's shared shell, in words.
//
// Split from `LeaseLine.tsx` so that module declares one component. The arm ORDER is
// the content: `unrecognized-transition` is answered before the null-holder arm,
// because a fold that refused to guess and a wire that said nobody holds it produce
// the same null holder and opposite sentences, and rendering the free-lease line for
// the first is the one thing here that is certainly wrong.

import { DerivedFigure, WireFigure } from "../primitives/index.js";
import type { TerminalLeaseHolding } from "./lease-model.js";
import type { TerminalParticipantMark } from "./participant-mark.js";

export interface HolderNameProps {
  readonly holding: TerminalLeaseHolding;
  readonly participantId: string | null;
  readonly mark: TerminalParticipantMark | undefined;
}

export function HolderName(props: HolderNameProps): React.JSX.Element {
  if (props.holding === "not-checked") {
    return <DerivedFigure text="The lease has not been read." />;
  }
  // Before the null-holder arm, which would otherwise render this state as the free
  // lease — the one sentence that is certainly wrong here. The holder is null
  // because the fold refused to guess, not because the wire said nobody holds it.
  if (props.holding === "unrecognized-transition") {
    return <DerivedFigure text="The console cannot read who holds the shell." />;
  }
  if (props.participantId === null) {
    return <DerivedFigure text="Nobody holds the shell." />;
  }
  if (props.holding === "held-by-you") {
    return <DerivedFigure text="You may type into the shared shell." />;
  }
  const displayName = props.mark?.displayName;
  return displayName === undefined ? (
    <span className="meridian-lease-line__holder-id">
      <DerivedFigure text="Held by" /> <WireFigure value={props.participantId} />
    </span>
  ) : (
    <DerivedFigure text={`${displayName} holds the shell.`} />
  );
}
