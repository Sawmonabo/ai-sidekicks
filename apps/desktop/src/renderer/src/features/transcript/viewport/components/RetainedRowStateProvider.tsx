// The retained row state's write channel, reachable from a row body.
// The virtualizer mounts only the visible range, so a row's own `useState` dies when it scrolls
// out; a row asks the window to remember its state instead, and a prune re-parks it under a
// synthetic key. A context, not a row-renderer prop, so row owners need no write path. Reads
// do not come through here: the feed overlays retained state onto the density it hands the row.

import { createContext, type Context } from "react";

import { type RetainedRowState } from "../retained-row-state-table.js";

/** What a row body may do to the state the window holds for it. */
export interface RetainedRowStateContextValue {
  /** Park this row's state on the window, where a prune re-parks rather than drops it. */
  readonly setLease: (rowKey: string, lease: RetainedRowState) => void;
}

/**
 * The channel, or `undefined` outside a transcript. Not a no-op default: that would
 * swallow every disclosure press in a tree that forgot the provider.
 */
export const RetainedRowStateContext: Context<RetainedRowStateContextValue | undefined> =
  createContext<RetainedRowStateContextValue | undefined>(undefined);

/** The channel to publish and the row bodies it reaches. */
export interface RetainedRowStateProviderProps {
  readonly channel: RetainedRowStateContextValue;
  readonly children: React.ReactNode;
}

/** Publish one transcript's retained-state channel to the row bodies it mounts. */
export function RetainedRowStateProvider(props: RetainedRowStateProviderProps): React.JSX.Element {
  return <RetainedRowStateContext value={props.channel}>{props.children}</RetainedRowStateContext>;
}
