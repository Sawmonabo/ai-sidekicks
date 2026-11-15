// What a waiting row reads beyond its own row: where its queue item stands, the acts on it, the
// drag that moves it, and whether the service can be reached. A context, as the row toggles are,
// so the person's message card reaches them without a prop through every row.

import { createContext, type Context } from "react";

import type { ReorderDrag } from "#renderer/lib/reorder-drag.js";
import type { Refusal } from "#renderer/lib/refusal/contract.js";
import type { ComposerRequests } from "#renderer/store/session/composer-requests.js";
import type { WaitingRow } from "./placement.js";
import type { QueueFeed } from "./reading.js";

/** The feed's waiting rows, the acts on them, and whether the service can be reached. */
export interface WaitingRows {
  /** Each waiting row by its key, in the order drawn. */
  readonly waitingRowByKey: ReadonlyMap<string, WaitingRow>;
  /** The session's queue reading, whose cancel, retry and reorder a waiting row offers. */
  readonly queue: QueueFeed;
  /** What the transcript asks of the session's composer: an edit, words back, a send now. */
  readonly composerRequests: ComposerRequests;
  /** The row whose words the draft is editing, or `undefined`. */
  readonly editingRowKey: string | undefined;
  /** Whether the lead has a turn running, which `Send now` interrupts. */
  readonly hasActiveTurn: boolean;
  /** Whether the service is out of reach, so each waiting row says it is not delivered yet. */
  readonly isServiceUnreachable: boolean;
  /** The pointer drag that moves a waiting row within the stack. */
  readonly drag: ReorderDrag<string>;
  /** Moves a waiting row one place up (`-1`) or down (`1`), as ↑ and ↓ on its grip do. */
  readonly moveRow: (rowKey: string, step: -1 | 1) => void;
  /** The last move's refusal, under the row it was asked of; cleared when another starts. */
  readonly moveRefusal: { readonly rowKey: string; readonly refusal: Refusal } | undefined;
  /** The last move that landed, under the row it moved, with the words that name its new place. */
  readonly lastMove: { readonly rowKey: string; readonly sentence: string } | undefined;
}

/** The feed's waiting rows; `undefined` outside a feed, where no row waits. */
export const WaitingRowsContext: Context<WaitingRows | undefined> = createContext<
  WaitingRows | undefined
>(undefined);
