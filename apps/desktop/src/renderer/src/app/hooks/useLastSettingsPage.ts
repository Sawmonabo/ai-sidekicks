// Who owns the app's one record of the settings page last open: built on the app's UI-state store,
// read once when it opens, and released when that store is replaced.

import { useEffect, useMemo } from "react";

import { LastSettingsPage } from "#renderer/store/last-settings-page.js";
import type { UiStateStore } from "#renderer/store/persistence/ui-state-store.js";

/** The settings page last open on this device, hydrated from `uiStateStore`. */
export function useLastSettingsPage(uiStateStore: UiStateStore): LastSettingsPage {
  const lastSettingsPage = useMemo(() => new LastSettingsPage(uiStateStore), [uiStateStore]);
  useEffect(() => {
    void lastSettingsPage.hydrate();
    return () => {
      lastSettingsPage.dispose();
    };
  }, [lastSettingsPage]);
  return lastSettingsPage;
}
