// Holding the column's one selection, and reading it in React.
//
// Two hooks and nothing else. The model is constructed once per column — one selection
// per sidebar, not one per section — and every reader goes through
// `useSyncExternalStore`, because the outcomes are written from replies that land
// outside React's knowledge. That is the same shape `deck/pane-drag.ts` gives the
// deck's indicator, for the same reason.

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";

import { type SidebarBulkSelection } from "../../../seats/index.js";
import {
  BulkSelectionModel,
  bulkSelectionFaceOf,
  type BulkSelectionSnapshot,
} from "./bulk-selection.js";

/** Hold one selection for the lifetime of the column that owns it. */
export function useBulkSelectionModel(): BulkSelectionModel {
  const [model] = useState(() => new BulkSelectionModel());
  return model;
}

/** Subscribe to the selection. The one read path; no component reads `snapshot`. */
export function useBulkSelectionSnapshot(model: BulkSelectionModel): BulkSelectionSnapshot {
  const subscribe = useCallback(
    (onStoreChange: () => void) => model.subscribe(onStoreChange),
    [model],
  );
  const read = useCallback(() => model.snapshot, [model]);
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * The narrow face the section context carries.
 *
 * Memoised on the model so the context object a section is handed keeps one identity
 * across the column's re-renders: a section body memoising on its context would
 * otherwise recompute on every keystroke in the filter field.
 */
export function useBulkSelectionFace(model: BulkSelectionModel): SidebarBulkSelection {
  return useMemo(() => bulkSelectionFaceOf(model), [model]);
}
