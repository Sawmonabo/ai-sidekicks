// The page the page list's tab stop rests on: the open page, or on the address that names none,
// the page last open, so `‹ Settings` puts the cursor back on the page just left.

import { useState } from "react";

import type { SettingsPageId } from "#renderer/routing/settings-page-ids.js";

/** The open page, else the one last open while this screen was mounted; `undefined` before any. */
export function useLastOpenedPageId(
  currentPageId: SettingsPageId | undefined,
): SettingsPageId | undefined {
  const [lastOpenedPageId, setLastOpenedPageId] = useState(currentPageId);
  // Adjusted while rendering rather than in an effect, so no commit draws the stale tab stop.
  if (currentPageId !== undefined && currentPageId !== lastOpenedPageId) {
    setLastOpenedPageId(currentPageId);
  }
  return currentPageId ?? lastOpenedPageId;
}
