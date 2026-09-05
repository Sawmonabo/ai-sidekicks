// The lease's transition history: one ledger line per transition, newest last.
//
// Split from `LeaseLine.tsx` so that module declares one component. 8.8 puts this
// history "one click away" rather than on the line, and every row NAMES ITS REASON —
// the sentence comes from `lease-transition.ts`'s table, which is total over the
// closed reason set, so the three automatic reasons cannot collapse into one.
//
// AN EMPTY LEDGER IS NOT A CLAIM ABOUT THE SHELL. Zero transitions means the console
// has read none since this session's log was opened here, which is a different fact
// from the shell never having moved, and the absence says so rather than rendering an
// empty feed a reader would take for the stronger claim.

import { LedgerRow, Nothing } from "../primitives/index.js";
import type { TerminalLeaseState } from "./lease-model.js";
import type { TerminalParticipantMarkReader } from "./participant-mark.js";
import { terminalLeaseTransitionSentence } from "./lease-transition.js";

export interface LeaseTransitionLedgerProps {
  readonly state: TerminalLeaseState;
  readonly markFor: TerminalParticipantMarkReader;
}

export function LeaseTransitionLedger(props: LeaseTransitionLedgerProps): React.JSX.Element {
  const { state, markFor } = props;
  if (state.transitions.length === 0) {
    return (
      <Nothing
        kind="not-checked"
        placement="surface"
        title="No transition has been read."
        detail="The lease has changed hands zero times since this session's log was opened here. That is not the same as the shell never having moved."
      />
    );
  }
  const labelFor = (participantId: string): string =>
    markFor(participantId)?.displayName ?? participantId;
  return (
    <div className="meridian-lease-line__ledger" role="feed" aria-label="Lease transitions">
      {state.transitions.map((transition) => {
        const actorId = transition.actorId;
        const mark = actorId === undefined ? undefined : markFor(actorId);
        return (
          <LedgerRow
            key={transition.sequence}
            participantHueStep={mark?.hueStep ?? -1}
            ringTreatment={mark?.ringTreatment ?? "solid"}
            occurredAtIso={transition.occurredAtIso}
            actorLabel={mark?.displayName ?? actorId ?? "The daemon"}
            kindLabel={transition.reason}
          >
            <p className="meridian-lease-line__sentence">
              {terminalLeaseTransitionSentence(transition, labelFor)}
            </p>
          </LedgerRow>
        );
      })}
    </div>
  );
}
