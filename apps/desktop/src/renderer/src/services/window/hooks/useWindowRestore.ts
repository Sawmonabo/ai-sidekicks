// The console document's side of main reopening windows. Main asks it to open a window again when
// none a person sees is open, on a Dock click or a second launch, and it tells main once `Restore
// windows` ended a safe start, so main keeps each window's place again.

import { useCallback, useEffect } from "react";

import type { PreloadApi } from "#shared/preload-api.js";

/** The `window` members the hook speaks. */
export type WindowRestoreMembers = Pick<
  PreloadApi["window"],
  "endSafeStart" | "subscribeToReopenRequest"
>;

/**
 * Opens each window main asks for with `reopen` while mounted, and answers the call that tells
 * main a safe start ended, which rejects with main's refusal.
 */
export function useWindowRestore(
  members: WindowRestoreMembers,
  reopen: (windowId: string) => void,
): () => Promise<void> {
  useEffect(() => members.subscribeToReopenRequest(reopen), [members, reopen]);
  return useCallback(() => members.endSafeStart(), [members]);
}
