// The lease line: where one of the session's shells is held, and the control region beside it.
// It states the holder from the fold and never derives it from a take: the line moves when a
// `pty.control_changed` transition reaches the fold. The take control is
// `LeaseTakeControl.tsx`, passed in `controls`.

import type { ReactNode } from "react";

import { Chip, type ChipTone } from "@renderer/components/Chip/Chip.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import { LeaseHolderSentence } from "./LeaseHolderSentence.js";
import { type TerminalLeaseHolder, type TerminalLeaseState } from "../lease-model.js";

/** What the lease line shows: the folded state and an optional control. */
export interface LeaseLineProps {
  readonly state: TerminalLeaseState;
  /** What sits beside the holder statement: the take control, where a caller has one. */
  readonly controls?: ReactNode;
}

/**
 * What the chip says for each holder; `null` draws no chip. `unrecognized-transition` is the
 * one attention tone: a person is needed, because the console cannot tell where the shell is
 * held, unlike the neutral "not checked" where it simply has not asked.
 */
const HOLDER_CHIPS: Readonly<
  Record<TerminalLeaseHolder, { label: string; tone: ChipTone } | null>
> = {
  "not-checked": { label: "Not checked", tone: "neutral" },
  unheld: { label: "Free", tone: "neutral" },
  "held-by-this-device": { label: "You hold it", tone: "accent" },
  "held-by-another-device": { label: "Held", tone: "neutral" },
  "held-by-run": null,
  "unrecognized-transition": { label: "Unread transition", tone: "attention" },
};

/** The lease line: the holder chip and statement, the control region, and the unread notice. */
export function LeaseLine(props: LeaseLineProps): React.JSX.Element {
  const { state } = props;
  const chip = HOLDER_CHIPS[state.holder];

  return (
    <div className="meridian-lease-line" role="group" aria-label="Terminal lease">
      <div className="meridian-lease-line__head">
        <span className="meridian-lease-line__holder">
          {chip === null ? null : <Chip tone={chip.tone} label={chip.label} />}
          <LeaseHolderSentence holder={state.holder} />
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
