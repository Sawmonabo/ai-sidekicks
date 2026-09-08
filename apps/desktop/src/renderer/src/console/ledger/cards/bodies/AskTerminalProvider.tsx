// The terminal an ask reached, reachable from the row that asked it.
//
// WHY A CONTEXT AND NOT A PROP ON THE ROW SEAT — the reasoning `ledger/frame/RowLeaseProvider.tsx`
// gives, applied to a third fact. `seats/single-slot/timeline-row-slot.ts` carries what the LIST
// decides about a row — the hue, the rollback supersession, the density — and whether a
// later row settled this row's ask is none of those: it is a fold over the window keyed
// by `askId`, and the seat contract is shared with a renderer this family does not own,
// so widening it would oblige every future row owner to carry a member it may never
// read. A context reaches the same row bodies through the same tree and leaves the seat
// exactly as it is.
//
// WHY THE MAP TRAVELS AND NOT A SUBSCRIBABLE CHANNEL, which is the opposite of what the
// reveal channel does and is decided by WHO CONSUMES IT. Live text is read by every
// mounted row, so publishing it through a context value would move `LedgerFeedRow`'s
// memo on every drained frame for every row. This map is read by the ask card ALONE —
// `FixtureShellRow` still reads its own row and consumes nothing here — so the only
// components a changed window re-renders through this context are the ask rows on
// screen, which is the set that has to re-render when a terminal lands. A stable
// channel with a subscription would buy nothing and would cost the machinery to
// maintain it.
//
// AND `undefined` OUTSIDE A LEDGER, where the lease channel throws. The two absences are
// different facts: a missing lease channel silently discards a disclosure press, which
// is a defect; a missing terminal map means no window has been folded around this row,
// and the row's own reading is then the whole truth about its ask — which is exactly
// what a single row rendered on its own is.

import { createContext, useContext } from "react";

import { type DriverAskReading } from "./input-ask.js";

/**
 * The terminals one window holds, or `undefined` outside a ledger.
 *
 * The map itself rather than a lookup function: it is derived once per window by the
 * row model and read by identity here, so a fresh object means a changed window and
 * nothing else re-derives it.
 */
const LedgerAskTerminalContext = createContext<ReadonlyMap<string, DriverAskReading> | undefined>(
  undefined,
);

export interface LedgerAskTerminalProviderProps {
  /** Every settled ask in this window, keyed by `askId`. */
  readonly terminalsByAskId: ReadonlyMap<string, DriverAskReading>;
  readonly children: React.ReactNode;
}

/** Publish one ledger's settled asks to the ask rows it mounts. */
export function LedgerAskTerminalProvider(
  props: LedgerAskTerminalProviderProps,
): React.JSX.Element {
  return (
    <LedgerAskTerminalContext value={props.terminalsByAskId}>
      {props.children}
    </LedgerAskTerminalContext>
  );
}

/**
 * The terminal this ask reached, or `undefined` while it is still open.
 *
 * Three states collapse into that one answer, and collapsing them is correct: the ask
 * is unsettled, no window has been folded around this row, or the terminal is this
 * row's own. In all three the request row keeps offering its answer controls, which is
 * what an ask nothing has settled is for.
 */
export function useLedgerAskTerminal(askId: string): DriverAskReading | undefined {
  return useContext(LedgerAskTerminalContext)?.get(askId);
}
