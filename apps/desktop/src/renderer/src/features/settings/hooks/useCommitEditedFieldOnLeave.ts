// Leaving Settings commits the field being edited.
//
// A field that commits on blur has to lose focus while its page is still mounted: React stops
// dispatching events while it commits a removal, so a blur the removal itself causes never reaches
// `onBlur`. The window store's listeners run as the route is set, before React renders Settings
// away, so the blur happens there. Nothing presses a `Save`, so a draft that waits behind its own
// `Save` writes nothing.

import { useEffect } from "react";
import { getWindow } from "@floating-ui/utils/dom";

import type { WindowStore } from "#renderer/store/window/store.js";

/** Blur the focused field inside `screen` when the window's route leaves Settings. */
export function useCommitEditedFieldOnLeave(
  frameStore: WindowStore,
  screen: HTMLElement | null,
): void {
  useEffect(() => {
    if (screen === null) {
      return undefined;
    }
    return frameStore.readable.subscribe((state) => {
      if (state.route.kind === "settings") {
        return;
      }
      const focused = screen.ownerDocument.activeElement;
      if (focused instanceof getWindow(screen).HTMLElement && screen.contains(focused)) {
        focused.blur();
      }
    });
  }, [frameStore, screen]);
}
