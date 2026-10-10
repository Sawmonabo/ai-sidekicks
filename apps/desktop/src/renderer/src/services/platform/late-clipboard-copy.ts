// A copy whose content comes after it was asked for, as a long selection's text read in slices
// or a picture's encoding does. Main reads what the clipboard holds when the copy is asked for,
// and the content, once made, is written only while the clipboard still holds that, so a copy
// made meanwhile, in this app or another, stands.

import type { ClipboardContent, ClipboardSnapshot } from "#shared/preload-api.js";
import type { PlatformBridge } from "./bridge.js";

/** A copy asked for now whose content is written later, unless a newer copy took the clipboard. */
export class LateClipboardCopy {
  readonly #native: PlatformBridge["native"];
  readonly #snapshot: Promise<ClipboardSnapshot>;

  /** Asks main for what the system clipboard, or the selection one, holds now. */
  public constructor(bridge: PlatformBridge, clipboard?: "selection") {
    this.#native = bridge.native;
    this.#snapshot = bridge.native.takeClipboardSnapshot(clipboard);
    // A refused read rejects the write that awaits it; a copy dropped before writing waits on none.
    this.#snapshot.catch(() => undefined);
  }

  /**
   * Writes `content` in one write unless a newer copy holds the clipboard: whether it was written.
   * Rejects when main refuses the read or the write.
   */
  public async write(content: ClipboardContent): Promise<boolean> {
    return this.#native.copyToClipboardUnlessChanged(content, await this.#snapshot);
  }
}
