// What a window says when main could not keep the color scheme it was asked for. Main's refusal
// crosses IPC and may name a subsystem the person cannot act on, so the banner says what it means.

import { refuse } from "#renderer/lib/refusal/refusal.js";
import type { WindowStore } from "#renderer/store/window/window-store.js";

/** Say on `frameStore`'s banner when main could not keep the scheme `asked` for. */
export function discloseUnkeptScheme(asked: Promise<void>, frameStore: WindowStore): void {
  void asked.catch(() => {
    frameStore.raiseRefusalBanner(UNKEPT_SCHEME);
  });
}

/** What a window's banner says when main could not keep a scheme. */
const UNKEPT_SCHEME = refuse(
  "appearance",
  "scheme-not-kept",
  "Could not save the color scheme, so it did not change.",
);
