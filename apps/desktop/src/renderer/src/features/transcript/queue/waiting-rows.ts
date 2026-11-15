// What a waiting row reads beyond its own row: where its queue item stands, the queue reading's
// acts, and whether the service can be reached. A context, as the row toggles are, so the person's
// message card reaches them without a prop through every row.

import { createContext, type Context } from "react";

import type { WaitingRow } from "./placement.js";
import type { QueueFeed } from "./reading.js";

/** The feed's waiting rows, the acts on them, and whether the service can be reached. */
export interface WaitingRows {
  /** Each waiting row by its key. */
  readonly waitingRowByKey: ReadonlyMap<string, WaitingRow>;
  /** The session's queue reading, whose cancel and retry a waiting row offers. */
  readonly queue: QueueFeed;
  /** Whether the service is out of reach, so each waiting row says it is not delivered yet. */
  readonly isServiceUnreachable: boolean;
}

/** The feed's waiting rows; `undefined` outside a feed, where no row waits. */
export const WaitingRowsContext: Context<WaitingRows | undefined> = createContext<
  WaitingRows | undefined
>(undefined);
