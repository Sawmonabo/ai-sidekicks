// What a waiting row reads beyond its own row: where its queue item stands, the acts on it, the
// drag that moves it, and whether the service can be reached. A context, as the row toggles are,
// so the person's message card reaches them without a prop through every row. The context holds
// one channel for the feed's life, and a row reads its own share through it, so a change to the
// waiting rows renders the rows that wait and no other.

import { createContext, type Context } from "react";

import { Emitter } from "#renderer/lib/emitter.js";
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

/**
 * The feed's waiting rows as its latest render holds them, read by each row for its own key. The
 * feed adopts each render's value as it renders and says it changed once that render commits.
 */
export class WaitingRowsChannel {
  readonly #changes = new Emitter<void>("waiting rows");
  #waitingRows: WaitingRows | undefined;

  /** Watch the waiting rows. */
  public subscribe = (listener: () => void): (() => void) => this.#changes.subscribe(listener);

  /** The waiting rows when the row under `rowKey` is one of them, else `undefined`. */
  public waitingRowsOf = (rowKey: string): WaitingRows | undefined =>
    this.#waitingRows?.waitingRowByKey.has(rowKey) === true ? this.#waitingRows : undefined;

  /** Holds `waitingRows` as the value rows read from now on, telling no watcher yet. */
  public adopt(waitingRows: WaitingRows): void {
    this.#waitingRows = waitingRows;
  }

  /** Tells every watcher the value adopted last stands, once the render that adopted it commits. */
  public publish(): void {
    this.#changes.emit();
  }
}

/** The line that names the words of the person's own prompt hook, which blocked a message. */
export function blockedByHookLine(hookWords: string): string {
  return `Blocked by your UserPromptSubmit hook: ${hookWords}`;
}

/** The feed's waiting rows channel; `undefined` outside a feed, where no row waits. */
export const WaitingRowsContext: Context<WaitingRowsChannel | undefined> = createContext<
  WaitingRowsChannel | undefined
>(undefined);

/** What a waiting row whose delivery failed says first, and is said as when it fails. */
export const NOT_DELIVERED_WORDS = "Not delivered";
