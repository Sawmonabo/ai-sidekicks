// A copy whose content comes after it was asked for, as a long selection's text read in slices
// or a picture's encoding does. Main reads what the clipboard holds when the copy is asked for,
// and the content, once made, is written only while the clipboard still holds that, so a copy
// made meanwhile, in this app or another, stands. Until a system-clipboard copy has written or
// given up it is held in the bridge's pending copies, which a paste in this app waits for.

import type { ClipboardContent } from "#shared/preload-api.js";
import type { PlatformBridge } from "../bridge.js";

/** Writes a late copy's content in one write: whether it was written. */
export type LateClipboardWrite = (content: ClipboardContent) => Promise<boolean>;

/**
 * Starts a copy now whose content `build` writes later through the write it is handed, which
 * lands only while no newer copy took the clipboard; settles as `build` does. A copy to the system
 * clipboard is pending until its first write settles or `build` settles, whichever comes first. A
 * refused read of the clipboard rejects that write.
 */
export function copyOnceBuilt<Result>(
  bridge: PlatformBridge,
  build: (write: LateClipboardWrite) => Promise<Result>,
  clipboard?: "selection",
): Promise<Result> {
  const snapshot = bridge.native.takeClipboardSnapshot(clipboard);
  // A refused read rejects the write that awaits it; a copy that writes nothing waits on none.
  snapshot.catch(() => undefined);
  let endPending = (): void => undefined;
  if (clipboard === undefined) {
    bridge.pendingClipboardCopies.hold(
      new Promise((resolve) => {
        endPending = resolve;
      }),
    );
  }
  const write: LateClipboardWrite = async (content) => {
    try {
      return await bridge.native.copyToClipboardUnlessChanged(content, await snapshot);
    } finally {
      endPending();
    }
  };
  const built = build(write);
  built.then(endPending, endPending);
  return built;
}
