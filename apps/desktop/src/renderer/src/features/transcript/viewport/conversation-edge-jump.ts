// A jump to the conversation's first or last row: Home, End, the tail pill and the palette's jump.
// Where the log does not reach that end, the page there is read in place of the log first, and
// its edge row is landed on once the log holding the page is handed over. A jump whose read fails
// lands nowhere, and a newer jump replaces one under way.

import { type WindowSide } from "./window-cap.js";

/**
 * Starts reading the page at an end of the conversation in place of the log, calling
 * `beforePageLands` just before the page takes the log's place; answers whether it started, not
 * when the log already reaches that end.
 */
export type JumpToLogEnd = (side: WindowSide, beforePageLands: () => void) => boolean;

/** What a jump reads an end of the conversation through, and how it lands there. */
export interface ConversationEdgeJumpOptions {
  /** Reads the page at an end the log does not reach; `undefined` reads nothing past the log. */
  readonly jumpToLogEnd: JumpToLogEnd | undefined;
  /** Lands the reader on the log's edge row on `side`. */
  readonly landOnLogEdge: (side: WindowSide) => void;
}

/** The newest jump to an end of the conversation, from its press until it lands. */
export class ConversationEdgeJump {
  readonly #options: ConversationEdgeJumpOptions;
  /** Every jump takes the next number; a read lands only while its number is the newest. */
  #jumpCount = 0;
  /** The side a read jump lands on once the log holding its page is handed over. */
  #owedLanding: WindowSide | undefined;
  #disposed = false;

  public constructor(options: ConversationEdgeJumpOptions) {
    this.#options = options;
  }

  /** Jumps to the conversation's end on `side`, reading its page first where the log lacks it. */
  public jump(side: WindowSide): void {
    this.#jumpCount += 1;
    this.#owedLanding = undefined;
    const jumpNumber = this.#jumpCount;
    // Owed before the page lands, so the render that hands its log over finds it.
    const beforePageLands = (): void => {
      if (!this.#disposed && jumpNumber === this.#jumpCount) {
        this.#owedLanding = side;
      }
    };
    if (this.#options.jumpToLogEnd?.(side, beforePageLands) !== true) {
      this.#options.landOnLogEdge(side);
    }
  }

  /** Takes the side a read jump lands on, once the log holding its page is handed over. */
  public takeOwedLanding(): WindowSide | undefined {
    const side = this.#owedLanding;
    this.#owedLanding = undefined;
    return side;
  }

  /** Terminal: no read jump lands after it. */
  public dispose(): void {
    this.#disposed = true;
  }
}
