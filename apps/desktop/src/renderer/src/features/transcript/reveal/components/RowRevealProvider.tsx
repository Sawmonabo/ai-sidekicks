// The reveal engine's published text, reachable from a row body.
//
// A context rather than a prop on the row seat: the seat carries what the list decides
// about a row (hue, supersession, density), and live text is not a property of a row's
// position in a list. The channel published here is stable; each row reads its own lane
// through `useSyncExternalStore`, so a drained frame that moved other lanes re-renders
// nothing in this one.

import { createContext, type Context } from "react";

import { type Unsubscribe } from "@renderer/lib/emitter.js";

/** How a row body reaches the text one lane of the reveal engine is publishing. */
export interface LedgerRowRevealChannel {
  /**
   * The published text for one lane, or `undefined` for a lane with nothing on it.
   *
   * Empty and absent are collapsed deliberately: a row body takes any string as a live
   * body and would render an empty one as a turn whose author said nothing.
   */
  readonly publishedTextFor: (laneId: string) => string | undefined;
  /** Called once per drained frame. The row decides whether its text moved. */
  readonly subscribe: (sink: () => void) => Unsubscribe;
}

/**
 * The channel, or `undefined` outside a transcript, which means no lane is streaming into
 * the row: the ordinary state of every row in a settled log.
 */
export const RowRevealContext: Context<LedgerRowRevealChannel | undefined> = createContext<
  LedgerRowRevealChannel | undefined
>(undefined);

/** The channel to publish and the row bodies it reaches. */
export interface LedgerRowRevealProviderProps {
  readonly channel: LedgerRowRevealChannel;
  readonly children: React.ReactNode;
}

/** Publish one transcript's reveal channel to the row bodies it mounts. */
export function LedgerRowRevealProvider(props: LedgerRowRevealProviderProps): React.JSX.Element {
  return <RowRevealContext value={props.channel}>{props.children}</RowRevealContext>;
}
