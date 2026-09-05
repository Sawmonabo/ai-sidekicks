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
//
// AND A TRUNCATED ONE IS NOT A CLAIM ABOUT THE LEASE. The fold keeps the newest
// `TERMINAL_LEASE_LEDGER_CAP` transitions and counts every one it saw, so a lease that
// moved forty-one times renders thirty-two rows under a disclosure whose own label
// says forty-one. Without a notice a person answering "who had it, and why did it
// move" is shown a feed that looks exhaustive and is not, with nothing saying which
// are missing or from which end. The producer already computed the figure the notice
// needs; this renders it through the console's ONE incomplete-reading vocabulary
// rather than a sentence of its own, which is the drift `primitives/partial-read.ts`
// exists to end.
//
// THE SUBJECT IS SINGULAR ON PURPOSE. That module's sentences agree with a singular
// verb — "read before <subject> was cut" — so a plural noun phrase comes out
// ungrammatical, and "this transition history" is the same fact said in the number the
// grammar around it is written in.

import { LedgerRow, Nothing, PartialRead, type ReadingState } from "../primitives/index.js";
import type { TerminalLeaseState } from "./lease-model.js";
import type { TerminalParticipantMarkReader } from "./participant-mark.js";
import { terminalLeaseTransitionSentence } from "./lease-transition.js";

/**
 * How completely the ledger's rows answer "every transition this console read".
 *
 * `cut` is the producer's own arm: the fold dropped the oldest transitions to stay
 * under its cap, and `servedCount` is what survived — the only figure that is a fact
 * rather than a subtraction of two counts a reader would have to trust.
 */
function transitionsReading(state: TerminalLeaseState): ReadingState {
  return state.transitionCount > state.transitions.length
    ? { kind: "cut", servedCount: state.transitions.length }
    : { kind: "served" };
}

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
      <PartialRead states={[transitionsReading(state)]} subject="this transition history" />
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
