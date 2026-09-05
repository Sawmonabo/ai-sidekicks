// What an offline host means for the shared shell's lease.
//
// Split from `LeaseLine.tsx` so that module declares one component. Total over the
// closed set by construction, for the reason every table in this family is: the two
// readings are different sentences, and one line serving both said "The holding node …
// is offline" under "Nobody holds the shell." — a holder claim about a lease the line
// beside it says nobody holds. What is true in both cases is that the host is down and
// the shell is read-only here, so the second sentence says that and claims no holder
// at all.

import { WireFigure } from "../primitives/index.js";
import type { TerminalOfflineNodeReading } from "./lease-model.js";

export interface OfflineNodeLineProps {
  readonly reading: TerminalOfflineNodeReading;
}

export function OfflineNodeLine(props: OfflineNodeLineProps): React.JSX.Element {
  const nodeId = <WireFigure value={props.reading.nodeId} />;
  switch (props.reading.effect) {
    case "holder-collapsed":
      return (
        <p className="meridian-lease-line__degraded">
          The holding node {nodeId} is offline, so the shell reads as free and stays read-only here.
        </p>
      );
    case "no-holder-shown":
      return (
        <p className="meridian-lease-line__degraded">
          The node {nodeId} that runs this shell is offline, so the shell stays read-only here.
        </p>
      );
  }
}
