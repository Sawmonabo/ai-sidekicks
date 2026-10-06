// The lease line: where one of the session's shells is held, and the control region beside it.
// It states the holder from the fold and never derives it from a take: the line moves when a
// `pty.control_changed` transition reaches the fold. Nothing is drawn until the holder has been
// read, or while this device holds the shell. The take control is `LeaseTakeControl.tsx`,
// passed in `controls`.

import "./LeaseLine.css";

import type { ReactNode } from "react";

import { Chip } from "#renderer/components/Chip/Chip.js";
import { LeaseHolderSentence } from "./LeaseHolderSentence.js";
import { type DrawnLeaseHolder, type TerminalLeaseState } from "../state.js";

/** What the lease line shows: the folded state and an optional control. */
export interface LeaseLineProps {
  readonly state: TerminalLeaseState;
  /** What sits beside the holder statement: the take control, where a caller has one. */
  readonly controls?: ReactNode;
}

/** What the chip says for each drawn holder; `null` draws no chip. */
const HOLDER_CHIP_LABELS: Readonly<Record<DrawnLeaseHolder, string | null>> = {
  unheld: "Free",
  "held-by-another-device": "Held",
  "held-by-run": null,
  "unrecognized-transition": null,
};

/** The lease line: the holder chip and statement and the control region, or nothing. */
export function LeaseLine(props: LeaseLineProps): React.JSX.Element | null {
  const { holder } = props.state;
  if (holder === "not-checked" || holder === "held-by-this-device") {
    return null;
  }
  const chipLabel = HOLDER_CHIP_LABELS[holder];

  return (
    <div className="meridian-lease-line" role="group" aria-label="Terminal lease">
      <div className="meridian-lease-line__head">
        <span className="meridian-lease-line__holder">
          {chipLabel === null ? null : <Chip tone="neutral" label={chipLabel} />}
          <LeaseHolderSentence holder={holder} />
        </span>
        <div className="meridian-lease-line__controls">{props.controls}</div>
      </div>
    </div>
  );
}
