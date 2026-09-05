// The reveal engine's published text, reachable from a row body.
//
// WHAT WAS BROKEN. `reveal-engine.ts` publishes per-lane text and says how much of it
// is safe to show; `ledger/cards/bodies/MachineBody.tsx` renders that text as `liveText` and
// takes it in preference to a stored body. Nothing joined the two. The engine was
// constructed nowhere, `liveText` was passed by nobody, and the feed reported the
// engine's drain state as the literal `false` — so a streamed body could not reach a
// row at all and the viewport's prune deferral was reading a constant rather than a
// scheduler.
//
// WHY A CONTEXT AND NOT A PROP ON THE ROW SEAT — the reasoning `RowLeaseProvider.tsx`
// already gives, and it holds harder here. `seats/timeline-row-slot.ts` carries what
// the LIST decides about a row (hue, supersession, density) and
// `ledger/cards/card-props.ts` states outright that live text is not one of those:
// it is "not a property of the row's position in a list". The seat contract is also
// shared with a renderer this family does not own, so widening it would oblige every
// future row owner to carry a member it may never read. A context reaches the same
// row bodies through the same tree and leaves the seat exactly as it is.
//
// WHY THE HOOK SUBSCRIBES RATHER THAN TAKING A VALUE OFF THE CONTEXT. Publishing the
// text ITSELF through the context would re-render every row body on every drained
// frame, which is the cost `card-props.ts` objects to — "a card that subscribed would
// re-render on frames its own text did not change in". What is published here is a
// STABLE channel, and each row reads its own lane through `useSyncExternalStore`, so
// the snapshot React compares is that lane's own string: a frame that moved three
// other lanes is `Object.is`-equal for this one and renders nothing.
//
// AND WHY `undefined` OUTSIDE A LEDGER, where the lease channel throws. The two
// absences are not the same fact. A missing lease channel silently discards a
// disclosure press, which is a defect that looks like a row that will not open; a
// missing reveal channel means no lane is streaming into this row, which is the
// ordinary state of every row in a settled log and is exactly what `MachineBody`
// renders when `liveText` is absent.

import { createContext, useCallback, useContext, useSyncExternalStore } from "react";

import { type Unsubscribe } from "../../../core/index.js";

/** How a row body reaches the text one lane of the reveal engine is publishing. */
export interface LedgerRowRevealChannel {
  /**
   * The published text for one lane, or `undefined` for a lane with nothing on it.
   *
   * Empty and absent are collapsed deliberately: `MachineBody` takes any string as a
   * live body and would render an empty one as a turn whose author said nothing,
   * which is the misreport its own header refuses.
   */
  readonly publishedTextFor: (laneId: string) => string | undefined;
  /** Called once per drained frame. The row decides whether ITS text moved. */
  readonly subscribe: (sink: () => void) => Unsubscribe;
}

/**
 * The channel, or `undefined` outside a ledger.
 *
 * `undefined` rather than a stub channel: a stub would be a second answer to "what is
 * this lane publishing", and the honest answer outside a ledger is that nothing is.
 */
const LedgerRowRevealContext = createContext<LedgerRowRevealChannel | undefined>(undefined);

export interface LedgerRowRevealProviderProps {
  readonly channel: LedgerRowRevealChannel;
  readonly children: React.ReactNode;
}

/** Publish one ledger's reveal channel to the row bodies it mounts. */
export function LedgerRowRevealProvider(props: LedgerRowRevealProviderProps): React.JSX.Element {
  return <LedgerRowRevealContext value={props.channel}>{props.children}</LedgerRowRevealContext>;
}

/** Nothing to unsubscribe from. Module-scope, so the subscribe callback stays stable. */
const NO_REVEAL_SUBSCRIPTION: Unsubscribe = () => {};

/**
 * The text the reveal engine is publishing for this lane right now.
 *
 * `undefined` when this row is not a lane, when no lane by that name has been seen,
 * or when the row is mounted outside a ledger — three states that are one answer as
 * far as a body is concerned: there is no live text, so the stored body's own
 * dispositions apply.
 */
export function useLedgerRowReveal(laneId: string | undefined): string | undefined {
  const channel = useContext(LedgerRowRevealContext);
  const subscribe = useCallback(
    (onChange: () => void): Unsubscribe =>
      channel === undefined ? NO_REVEAL_SUBSCRIPTION : channel.subscribe(onChange),
    [channel],
  );
  const readPublishedText = useCallback(
    (): string | undefined =>
      channel === undefined || laneId === undefined ? undefined : channel.publishedTextFor(laneId),
    [channel, laneId],
  );
  return useSyncExternalStore(subscribe, readPublishedText);
}
