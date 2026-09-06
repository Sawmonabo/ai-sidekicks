// The row lease, reachable from a row body — the one thing the window's lease
// machinery was missing.
//
// WHAT WAS BROKEN. `window-cap.ts` has held a lease table since it was written, with
// a promise in its own header: "a row a person had expanded comes back expanded when
// they page to it again, because its state was re-parked under a synthetic key
// rather than deleted with the row." Nothing production-side ever called `lease` or
// `setLease`; the only writer of an expansion was a `useState` inside the row body
// itself, and the virtualizer mounts only the visible range — so scrolling a row out
// unmounted it and threw the choice away. The promise was kept by nothing and the
// defect was invisible until somebody scrolled back.
//
// WHY A CONTEXT AND NOT A PROP ON THE ROW SEAT. `seats/timeline-row-slot.ts`
// declares what the LIST decides for a row — the hue, the superseded ranking, the
// density — and a lease is not a fourth decision of that kind: it is the row body
// asking the list to REMEMBER something. Widening the seat would make every future
// row owner implement a write path it may not want, and the seat contract is shared
// with a renderer this family does not own. A context reaches the same row bodies
// through the same tree and leaves the seat exactly as it is.
//
// THE READ SIDE DOES NOT COME THROUGH HERE. `LedgerFeed` overlays the lease onto the
// density it hands the seat, so a row body reads its own state through the prop it
// already had and this context carries only the write. One direction, one owner: the
// list remains the single answer to "is this row open".

import { createContext, useContext } from "react";

import { type LedgerRowLease } from "./row-lease-table.js";

/** What a row body may do to the state the window holds for it. */
export interface LedgerRowLeaseChannel {
  /** Park this row's state on the window, where a prune re-parks rather than drops it. */
  readonly setLease: (rowKey: string, lease: LedgerRowLease) => void;
}

/**
 * The channel, or `undefined` outside a ledger.
 *
 * `undefined` rather than a no-op default, deliberately: a no-op would swallow every
 * disclosure press in a tree that forgot the provider and look exactly like a row
 * that will not open. The hook below refuses instead.
 */
const LedgerRowLeaseContext = createContext<LedgerRowLeaseChannel | undefined>(undefined);

export interface LedgerRowLeaseProviderProps {
  readonly channel: LedgerRowLeaseChannel;
  readonly children: React.ReactNode;
}

/** Publish one ledger's lease channel to the row bodies it mounts. */
export function LedgerRowLeaseProvider(props: LedgerRowLeaseProviderProps): React.JSX.Element {
  return <LedgerRowLeaseContext value={props.channel}>{props.children}</LedgerRowLeaseContext>;
}

/**
 * The lease channel for the row being rendered.
 *
 * Throws outside a ledger rather than answering with a stub, for the reason on the
 * context above: a silently discarded write is the exact defect this module exists
 * to close, and reintroducing it as a default would be worse than the local state it
 * replaced.
 */
export function useLedgerRowLease(): LedgerRowLeaseChannel {
  const channel = useContext(LedgerRowLeaseContext);
  if (channel === undefined) {
    throw new Error("a ledger row body was mounted outside a ledger row lease provider");
  }
  return channel;
}
