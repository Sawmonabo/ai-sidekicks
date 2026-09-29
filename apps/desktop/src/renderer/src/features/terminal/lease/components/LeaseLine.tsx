// The lease line: where the session's one shared shell is held, and the control region
// beside it.
//
// The pane shows output and this line only. The line states the holder from the fold
// and never derives it from a take: it moves when a `pty.control_changed` transition
// reaches the fold, and not before. The take control is `LeaseTakeControl.tsx`, which
// a caller puts in `controls`.

import type { ReactNode } from "react";

import { Chip, WireFigure, type ChipTone } from "@renderer/console/primitives/index.js";
import { LeaseHolderSentence } from "./LeaseHolderSentence.js";
import { type TerminalLeaseHolder, type TerminalLeaseState } from "../lease-model.js";

/** What the lease line shows: the folded state and an optional control. */
export interface LeaseLineProps {
  readonly state: TerminalLeaseState;
  /** What sits beside the holder statement: the take control, where a caller has one. */
  readonly controls?: ReactNode;
}

/**
 * What the chip says for each holding. Total over the closed set.
 *
 * `unrecognized-transition` is the one amber row, and amber is spent on exactly what it
 * means: a person is needed. The daemon moved the shell under a transition this build
 * cannot read, so where it is held cannot be told until somebody updates this console
 * or looks at the log — which is a different thing from the neutral "not checked",
 * where the console simply has not asked.
 */
const HOLDING_CHIPS: Readonly<Record<TerminalLeaseHolder, { label: string; tone: ChipTone }>> = {
  "not-checked": { label: "Not checked", tone: "neutral" },
  unheld: { label: "Free", tone: "neutral" },
  "held-by-this-device": { label: "You hold it", tone: "accent" },
  "held-by-another-device": { label: "Held", tone: "neutral" },
  "unrecognized-transition": { label: "Unread transition", tone: "attention" },
};

/** The lease line: the holder chip and statement, the control region, and the unread notice. */
export function LeaseLine(props: LeaseLineProps): React.JSX.Element {
  const { state } = props;
  const chip = HOLDING_CHIPS[state.holding];

  return (
    <div className="meridian-lease-line" role="group" aria-label="Terminal lease">
      <div className="meridian-lease-line__head">
        <span className="meridian-lease-line__holder">
          <Chip tone={chip.tone} label={chip.label} />
          <LeaseHolderSentence holding={state.holding} />
        </span>
        <div className="meridian-lease-line__controls">{props.controls}</div>
      </div>

      {state.unreadTransition === undefined ? null : (
        <p className="meridian-lease-line__unread">
          The shell changed hands under a transition this build cannot read, so where it is held is
          not shown and the shell stays read-only.
          {state.unreadTransition.reason === undefined ? null : (
            <>
              {" "}
              The wire called it <WireFigure value={state.unreadTransition.reason} />.
            </>
          )}
        </p>
      )}
    </div>
  );
}
