// The page the page list rests on: the open page, kept as the page last open as it changes, or,
// on the address that names none, the page last open, so `‹ Settings` puts the cursor back on the
// page just left and reopening Settings opens it again.

import { useCallback, useEffect, useSyncExternalStore } from "react";

import type { SettingsPageId } from "#renderer/routing/settings-page-ids.js";
import type { LastSettingsPage } from "#renderer/store/last-settings-page.js";

/** Record `currentPageId` as the page last open, and answer the open page or the one last open. */
export function useLastSettingsPageId(
  lastSettingsPage: LastSettingsPage,
  currentPageId: SettingsPageId | undefined,
): SettingsPageId | undefined {
  useEffect(() => {
    if (currentPageId !== undefined) {
      lastSettingsPage.record(currentPageId);
    }
  }, [lastSettingsPage, currentPageId]);
  const subscribe = useCallback(
    (onChange: () => void) => lastSettingsPage.subscribe(onChange),
    [lastSettingsPage],
  );
  const readPageId = useCallback(() => lastSettingsPage.pageId, [lastSettingsPage]);
  const lastPageId = useSyncExternalStore(subscribe, readPageId, readPageId);
  return currentPageId ?? lastPageId;
}
