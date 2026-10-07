// Leaving a settings page commits the field being edited on it.
//
// A field that commits on blur has to lose focus while its page is still mounted: React stops
// dispatching events while it commits a removal, so a blur the removal itself causes never reaches
// `onBlur`. The window store's listeners run as the route is set, before React renders the page
// away, so the blur happens there: when Settings closes, and when Back, Forward or a link opens
// another settings page. Only the page pane is watched, since the list and the search box hold no
// value to commit. Nothing presses a `Save`, so a draft that waits behind its own `Save` writes
// nothing.

import { useEffect } from "react";
import { getWindow } from "@floating-ui/utils/dom";

import type { WindowStore } from "#renderer/store/window/store.js";
import type { AppRoute } from "#renderer/routing/routes.js";

/** Blur the focused field inside `pagePane` when the window's route leaves the open page. */
export function useCommitEditedFieldOnLeave(
  frameStore: WindowStore,
  pagePane: HTMLElement | null,
): void {
  useEffect(() => {
    if (pagePane === null) {
      return undefined;
    }
    return frameStore.readable.subscribe((state, previousState) => {
      if (!leavesSettingsPage(previousState.route, state.route)) {
        return;
      }
      const focused = pagePane.ownerDocument.activeElement;
      if (focused instanceof getWindow(pagePane).HTMLElement && pagePane.contains(focused)) {
        focused.blur();
      }
    });
  }, [frameStore, pagePane]);
}

/** Whether moving between the two routes takes away the settings page the first one showed. */
function leavesSettingsPage(previousRoute: AppRoute, route: AppRoute): boolean {
  if (previousRoute.kind !== "settings") {
    return false;
  }
  return route.kind !== "settings" || route.page !== previousRoute.page;
}
