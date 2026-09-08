// What the roster says about the shared terminal, under its rows.
//
// Its own module because it is its own component and the console's `.tsx` modules
// hold one each — and because the line is not about presence: the roster reads who is
// HERE, and this reads who holds one session-scoped write lease. Two reads, two
// components, and the second one renders nothing at all until its own has answered.

import { DerivedFigure } from "../../primitives/index.js";
import type { ChannelActivityLabels } from "../activity-model.js";
import type { TerminalControlHolding } from "./terminal-control-holder.js";

/**
 * The line itself.
 *
 * Three renderings for three states and never two: a lease nobody holds is a fact
 * this surface states out loud, because it is the state in which a person may take
 * it, and a read that has not answered says nothing at all rather than implying the
 * lease is free. A HELD lease is already marked on its own row, so the line names the
 * holder rather than repeating the mark.
 */
export function TerminalControlLine(props: {
  readonly holding: TerminalControlHolding;
  readonly labels: ChannelActivityLabels;
}): React.JSX.Element | null {
  if (props.holding.kind === "unread") {
    return null;
  }
  return (
    <p className="meridian-roster__terminal-control">
      <DerivedFigure
        text={
          props.holding.kind === "unheld"
            ? "Nobody is holding the shared terminal."
            : `${props.labels.participantLabel(props.holding.participantId)} is holding the shared terminal.`
        }
      />
    </p>
  );
}
