// The kept window layout: which windows of session views were open, keyed by window id, the id
// main's own place file keeps each window's place under. The app opens the window used last first
// and the rest from here. It holds every window open now, and the last one closed while none other
// is open, so a reopen brings that window back; it is read from storage, so each entry is checked.

import { isConsoleWindowId } from "#shared/window/frame-name.js";
import type { PersistableValue } from "../persistence/persisted-value-classes.js";
import type { PersistenceWriteResult, UiStateStore } from "../persistence/ui-state-store.js";

/** The global key the kept window layout is stored under. */
const KEPT_WINDOWS_KEY = "windows";

/** The kept windows' ids, in the order they were kept; empty when none were. */
export async function readKeptWindowIds(uiStateStore: UiStateStore): Promise<readonly string[]> {
  const record = await uiStateStore.readGlobal(KEPT_WINDOWS_KEY);
  const layout = record?.value;
  if (
    layout === undefined ||
    layout === null ||
    typeof layout !== "object" ||
    Array.isArray(layout)
  ) {
    return [];
  }
  return Object.entries(layout as Readonly<Record<string, PersistableValue>>)
    .flatMap(([windowId, entry]): (readonly [string, number])[] => {
      const order = (entry as { readonly order?: unknown } | null)?.order;
      return isConsoleWindowId(windowId) && typeof order === "number" ? [[windowId, order]] : [];
    })
    .sort(([, left], [, right]) => left - right)
    .map(([windowId]) => windowId);
}

/**
 * Keep `windowIds` as the open windows, in this order. A refused write is counted on the store's
 * health, which the person sees, as every refused UI-state write is.
 */
export async function keepWindowIds(
  uiStateStore: UiStateStore,
  windowIds: readonly string[],
): Promise<PersistenceWriteResult> {
  const layout: Record<string, PersistableValue> = {};
  windowIds.forEach((windowId, order) => {
    layout[windowId] = { order };
  });
  return await uiStateStore.writeGlobal(KEPT_WINDOWS_KEY, "layout", layout);
}
