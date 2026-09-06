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
// AND ZERO ROWS HAS TWO CAUSES, WHICH IS WHY THE ABSENCE IS NOT ONE SENTENCE. A log
// that carried no transition and a log whose every transition was one this build
// could not read both leave the rows empty, and only the first of them supports
// "changed hands zero times". Said on the second, that sentence contradicts the lease
// line directly above it on the same pane — which renders "the shell changed hands
// under a transition this build cannot read" off the same fold — so the empty arm
// takes the readings too, and its own sentence is chosen by the one figure that tells
// the two causes apart.
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
// NEITHER IS A LEDGER THE FOLD COULD NOT READ THE WHOLE OF. A transition this build
// cannot read changes no row, so the rows are as long as they would have been had the
// daemon never sent it — which is exactly why the rows alone cannot show it, and why
// a ledger deriving completeness from the cap alone reported the one state the fold
// records as unreadable as the one state that claims completeness. Both readings are
// handed over, because that module admits no call shape that shows one and hides the
// other.
//
// THE SUBJECT IS SINGULAR ON PURPOSE. That module's sentences agree with a singular
// verb — "read before <subject> was cut" — so a plural noun phrase comes out
// ungrammatical, and "this transition history" is the same fact said in the number the
// grammar around it is written in.
//
// AND THE NOTICE IS NOT A MEMBER OF THE FEED. WAI-ARIA's `feed` role owns `article`
// elements, which is what `LedgerRow` renders and what a reader walking this
// disclosure article-to-article lands on. A notice mounted inside it is skipped by
// exactly the navigation the feed exists to support — so the person most likely to
// read this as a feed would be the one not told that rows are missing, which inverts
// the notice's purpose. It sits above the feed, in the box that holds both, because
// it is about the feed rather than one of its entries.

import {
  LedgerRow,
  Nothing,
  PartialRead,
  unreadableDeliveryReading,
  type ReadingState,
} from "../../primitives/index.js";
import type { TerminalLeaseState } from "./lease-model.js";
import type { TerminalParticipantMarkReader } from "./participant-mark.js";
import { terminalLeaseTransitionSentence } from "./lease-transition.js";

/**
 * How completely the ledger's rows answer "every transition this console read".
 *
 * TWO READINGS, because the fold holds two incompletenesses that a person acts on
 * differently. `cut` is the producer's own arm: the fold dropped the oldest
 * transitions to stay under its cap, and `servedCount` is what survived — the only
 * figure that is a fact rather than a subtraction of two counts a reader would have
 * to trust. `partial` is the deliveries arm: transitions arrived that this build
 * could not read, and they are missing from the rows without shortening them.
 *
 * THE UNREADABLE ARM CARRIES NO REFUSAL, and that is a property of the wire rather
 * than an omission. `lease-transition.ts` keeps whatever the payload called the
 * transition verbatim and mints no code for it, so there is no `ConsoleRefusal` to
 * hand over — and the lease line renders that string in its own sentence beside this
 * disclosure. A refusal invented here would be the surface writing a vocabulary the
 * daemon never sent.
 *
 * The zero cases are the producers' own: `unreadableDeliveryReading` answers `served`
 * below one, and the cap comparison answers `served` when nothing was dropped, so a
 * complete ledger hands over two served readings and `PartialRead` renders nothing.
 */
function transitionReadings(state: TerminalLeaseState): readonly ReadingState[] {
  return [
    state.transitionCount > state.transitions.length
      ? { kind: "cut", servedCount: state.transitions.length }
      : { kind: "served" },
    unreadableDeliveryReading(state.unreadableTransitionCount, undefined),
  ];
}

/**
 * What the absence says, chosen by the figure that says why the rows are empty.
 *
 * The fold's `unreadableTransitionCount` is the discriminator and the only one
 * available: `transitionCount` and `transitions.length` are equal at zero on both
 * causes, so nothing else in the state can tell "the log carried none" from "the log
 * carried some and none of them could be read". The count itself and what to do
 * about it are the notice's, rendered above this by the one incomplete-reading
 * vocabulary; this sentence says only which of the two absences a reader is looking
 * at, and never asserts a number of moves the fold did not establish.
 */
function emptyLedgerDetail(unreadableTransitionCount: number): string {
  if (unreadableTransitionCount === 0) {
    return (
      "The lease has changed hands zero times since this session's log was opened here. " +
      "That is not the same as the shell never having moved."
    );
  }
  return (
    "Every transition this session's log carried here arrived in a form this build cannot read, " +
    "so how often the shell has moved is not something this history can say."
  );
}

export interface LeaseTransitionLedgerProps {
  readonly state: TerminalLeaseState;
  readonly markFor: TerminalParticipantMarkReader;
}

export function LeaseTransitionLedger(props: LeaseTransitionLedgerProps): React.JSX.Element {
  const { state, markFor } = props;
  const readings = transitionReadings(state);
  if (state.transitions.length === 0) {
    return (
      <div className="meridian-lease-line__ledger">
        <PartialRead states={readings} subject="this transition history" />
        <Nothing
          kind="not-checked"
          placement="surface"
          title="No transition has been read."
          detail={emptyLedgerDetail(state.unreadableTransitionCount)}
        />
      </div>
    );
  }
  const labelFor = (participantId: string): string =>
    markFor(participantId)?.displayName ?? participantId;
  return (
    <div className="meridian-lease-line__ledger">
      <PartialRead states={readings} subject="this transition history" />
      <div className="meridian-lease-line__ledger-feed" role="feed" aria-label="Lease transitions">
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
    </div>
  );
}
