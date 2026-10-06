// What a window says when main could not keep the color scheme it was asked for. Main's refusal
// crosses IPC and may name a subsystem the person cannot act on, so the banner says what it means.
// A scheme the window asked for is told on that window; one picked from the View menu, which main
// reports on its own, is told on the window used last.

import { refuse } from "#renderer/lib/refusal/contract.js";
import type { WindowStore } from "#renderer/store/window/store.js";
import type { PreloadApi, Unsubscribe } from "#shared/preload-api.js";

/** Say on `frameStore`'s banner when main could not keep the scheme `asked` for. */
export function discloseUnkeptScheme(asked: Promise<void>, frameStore: WindowStore): void {
  void asked.catch(() => {
    frameStore.raiseRefusalBanner(UNKEPT_SCHEME);
  });
}

/**
 * Say on the banner of the window used last each time main reports that a scheme picked from the
 * View menu was not kept, until the returned call; nothing while no window is open.
 */
export function discloseUnkeptMenuSchemes(
  members: Pick<PreloadApi["window"], "subscribeToUnkeptScheme">,
  windowStoreUsedLast: () => WindowStore | undefined,
): Unsubscribe {
  return members.subscribeToUnkeptScheme(() => {
    windowStoreUsedLast()?.raiseRefusalBanner(UNKEPT_SCHEME);
  });
}

/** What a window's banner says when main could not keep a scheme. */
const UNKEPT_SCHEME = refuse(
  "appearance",
  "scheme-not-kept",
  "Could not save the color scheme, so it did not change.",
);
