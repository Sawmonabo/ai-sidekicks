// The reveal engine's published text, reachable from a row body through a context rather than a
// prop: row props carry what the list decides about a row, and live text is not that. The
// channel is stable and each row reads its own lane through `useSyncExternalStore`, so a drained
// frame that moved other lanes re-renders nothing here. Beside it rides the record of what each
// reply row has drawn, which outlives a retired lane.

import { createContext, type Context } from "react";

import type { Unsubscribe } from "#shared/preload-api.js";
import { type DrawnReplyText } from "../../copy/drawn-reply-text.js";
import { type PublishedText } from "../published-text.js";

/** How a row body reaches the text one lane of the reveal engine is publishing. */
export interface RowRevealContextValue {
  /**
   * The published text for one lane, as the lane's stable handle, or `undefined` for a lane with
   * nothing on it.
   *
   * Empty and absent are collapsed deliberately: a row body takes any text as a live
   * body and would render an empty one as a turn whose author said nothing.
   */
  readonly publishedTextFor: (laneId: string) => PublishedText | undefined;
  /** What each reply row has drawn, kept after its lane retires or its row unmounts. */
  readonly drawnReplyText: DrawnReplyText;
  /** Called once per drained frame. The row decides whether its text moved. */
  readonly subscribe: (sink: () => void) => Unsubscribe;
}

/**
 * The channel, or `undefined` outside a transcript, which means no lane is streaming into
 * the row: the ordinary state of every row in a settled log.
 */
export const RowRevealContext: Context<RowRevealContextValue | undefined> = createContext<
  RowRevealContextValue | undefined
>(undefined);

/** The channel to publish and the row bodies it reaches. */
export interface RowRevealProviderProps {
  readonly channel: RowRevealContextValue;
  readonly children: React.ReactNode;
}

/** Publish one transcript's reveal channel to the row bodies it mounts. */
export function RowRevealProvider(props: RowRevealProviderProps): React.JSX.Element {
  return <RowRevealContext value={props.channel}>{props.children}</RowRevealContext>;
}
