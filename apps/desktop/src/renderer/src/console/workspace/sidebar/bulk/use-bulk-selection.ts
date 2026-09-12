// Holding the column's one selection, and reading it in React.
//
// Three hooks and nothing else. The model is one per sidebar — not one per section —
// and every reader goes through `useSyncExternalStore`, because the outcomes are
// written from replies that land outside React's knowledge. That is the same shape
// `deck/pane-drag.ts` gives the deck's indicator, for the same reason.
//
// AND IT IS ONE PER SESSION, WHICH IS THE HOLDER'S JOB AND NOT A CLEAR. The column is
// mounted once and re-bound as the workspace moves between sessions, so a model held
// for the MOUNT carried session A's ticked rows and settled outcomes into session B —
// where the bar then handed B's session id to the runner beside A's queue-item and
// worktree ids, and A's later settlements rendered under B. The module
// `store/subject-scoped/subject-scoped-state.ts` exists for exactly that failure and
// states its own rule: the pass that first sees a
// new subject already reads that subject's own value. A manual clear cannot make that
// claim — it runs after a render that has already handed the old set to whatever asked.

import { useCallback, useMemo, useSyncExternalStore } from "react";

import { type ConsoleBridge } from "../../../bridge/index.js";
import { useSessionScopedState, type SidebarBulkSelection } from "../../../seats/index.js";
import {
  BulkSelectionModel,
  bulkSelectionFaceOf,
  type BulkSelectionSnapshot,
} from "./bulk-selection.js";

/**
 * Hold one selection per `(bridge, session)`.
 *
 * The bridge is the subject and the session is the key, which is the session door's
 * own pairing: a replaced bridge retires every bulk call in flight through it, and one
 * bridge carries many sessions. A model this hook drops releases nothing — its
 * subscribers re-subscribe to the replacement on the same render — which is why this
 * is the state holder and not the resource one.
 */
export function useBulkSelectionModel(
  bridge: ConsoleBridge,
  sessionId: string | undefined,
): BulkSelectionModel {
  return useSessionScopedState(bridge, sessionId, () => new BulkSelectionModel()).value;
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
