// The window's supervisor condition, reachable from a row body.
//
// WHY A CONTEXT AND NOT A PROP ON THE ROW SEAT, which is `RowLeaseProvider.tsx`'
// question with a different answer behind it. `seats/single-slot/timeline-row-slot.ts`
// declares what the LIST decides for a row — the hue, the superseded ranking, the
// density — and the shell's condition is none of those: it is a fact about the window,
// published by a store the ledger's own pane already holds, and every surface in the
// console that dispatches a mutating call reads it. Widening a seat shared with a
// renderer this family does not own, so that one row body can ask whether the runtime
// is serving, would make every future row owner carry a member about the supervisor.
//
// WHAT IT PUBLISHES IS THE STORE AND NOT A DERIVED BLOCK, and that is the whole point
// of it. A dispatching surface owes TWO readings — the subscribed one that draws the
// control and the one taken at the instant the call is put — and only a store can
// answer the second: a block handed down as a value is as old as the render that
// composed it, which is exactly the value `currentShellBlock` exists to bypass.
//
// AND IT REFUSES OUTSIDE A LEDGER rather than answering with a stub, for the reason
// `RowLeaseProvider.tsx` gives about its own channel and more so here: an absent
// provider read as "nothing blocks this" would fail OPEN, and a guard that fails open
// is the defect this seam closes rather than a degradation of it.

import { createContext, useContext } from "react";

import { type FrameStore } from "../../store/index.js";

/** What a row body may read about the runtime it would dispatch through. */
export interface LedgerShellConditionChannel {
  /** The window's own store, so a dispatcher can read the block at the instant it calls. */
  readonly frameStore: FrameStore;
}

/**
 * The channel, or `undefined` outside a ledger.
 *
 * `undefined` rather than a permissive default: see this module's header on why an
 * absent provider must not read as an open runtime.
 */
const LedgerShellConditionContext = createContext<LedgerShellConditionChannel | undefined>(
  undefined,
);

export interface LedgerShellConditionProviderProps {
  readonly channel: LedgerShellConditionChannel;
  readonly children: React.ReactNode;
}

/** Publish this window's shell condition to the row bodies the ledger mounts. */
export function LedgerShellConditionProvider(
  props: LedgerShellConditionProviderProps,
): React.JSX.Element {
  return (
    <LedgerShellConditionContext value={props.channel}>
      {props.children}
    </LedgerShellConditionContext>
  );
}

/**
 * The shell condition for the row being rendered.
 *
 * Throws outside a ledger rather than answering with a stub, so a tree that forgot the
 * provider is a failure at the mount rather than a control that stays live through an
 * outage and puts a write through a supervisor that is not serving.
 */
export function useLedgerShellCondition(): LedgerShellConditionChannel {
  const channel = useContext(LedgerShellConditionContext);
  if (channel === undefined) {
    throw new Error("a ledger row body was mounted outside a ledger shell condition provider");
  }
  return channel;
}
