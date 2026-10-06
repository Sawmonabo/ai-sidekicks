import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import type { Refusal } from "#renderer/lib/refusal/contract.js";
import { DurableViewState } from "#renderer/store/persistence/durable-view-state.js";
import type { UiStateStore } from "#renderer/store/persistence/ui-state-store.js";
import {
  NO_RUN_FILTERS,
  RUN_FILTERS_KEY,
  narrowRunFilters,
  persistedRunFilters,
  type RunFilters,
} from "../filters.js";

/** The runs table's filters, the act that changes them, and the last refused write. */
export interface RunFiltersHold {
  readonly filters: RunFilters;
  readonly setFilters: (next: RunFilters) => void;
  readonly lastRefusal: Refusal | undefined;
}

/**
 * The runs table's four filters, kept on this device: read once when the screen opens, written
 * on every change, and drawn from memory first so a store that is empty or refuses still leaves
 * the table working.
 */
export function useRunFilters(uiStateStore: UiStateStore): RunFiltersHold {
  const state = useMemo(
    () =>
      new DurableViewState<Record<string, string>>({
        store: uiStateStore,
        key: RUN_FILTERS_KEY,
        valueClass: "selection",
        initial: persistedRunFilters(NO_RUN_FILTERS),
        narrow: (raw) => {
          const narrowed = narrowRunFilters(raw);
          return narrowed === undefined ? undefined : persistedRunFilters(narrowed);
        },
      }),
    [uiStateStore],
  );
  useEffect(() => {
    void state.hydrate();
    return () => {
      state.dispose();
    };
  }, [state]);
  const subscribe = useCallback(
    (onStoreChange: () => void) => state.subscribe(onStoreChange),
    [state],
  );
  const readValue = useCallback(() => state.value, [state]);
  const stored = useSyncExternalStore(subscribe, readValue, readValue);
  const readRefusal = useCallback(() => state.lastRefusal, [state]);
  const lastRefusal = useSyncExternalStore(subscribe, readRefusal, readRefusal);
  const filters = useMemo(() => narrowRunFilters(stored) ?? NO_RUN_FILTERS, [stored]);
  const setFilters = useCallback(
    (next: RunFilters) => {
      void state.commit(persistedRunFilters(next));
    },
    [state],
  );
  return { filters, setFilters, lastRefusal };
}
