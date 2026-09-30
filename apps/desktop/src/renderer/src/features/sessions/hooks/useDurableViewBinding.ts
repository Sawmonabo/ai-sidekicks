import { useCallback, useEffect, useState } from "react";

import type { UiStateStore } from "@renderer/store/persistence/ui-state-store.js";
import {
  type DurableViewBinding,
  type DurableViewBindingAccess,
  type DurableViewBindingHolder,
} from "../durable-view/durable-view-binding.js";

/**
 * Bind one durable view state to the store a view was handed. The binding is acquired in an
 * effect and only read during render, so state lags its inputs by one committed frame and the
 * opening arm renders in it. The holder is the caller's, declared once at module scope: one
 * minted here would be per mount, and two mounts would be two writers of one record.
 */
export function useDurableViewBinding<TBinding extends DurableViewBinding>(
  holder: DurableViewBindingHolder<TBinding>,
  store: UiStateStore,
): DurableViewBindingAccess<TBinding> {
  const [acquiredBinding, setAcquiredBinding] = useState<TBinding | undefined>(() =>
    // Seeded from the pure lookup so a remount over the same store skips the opening arm.
    holder.bindingIfCurrent(store),
  );

  useEffect(() => {
    const binding = holder.acquire(store);
    // The durable read rides the effect, so a discarded render performs none. Idempotent per
    // binding, so strict mode's second run asks nothing twice.
    void binding.hydrate();
    setAcquiredBinding(binding);
  }, [holder, store]);

  const liveBinding = holder.bindingIfCurrent(store);
  return {
    binding: acquiredBinding === liveBinding ? acquiredBinding : undefined,
    acquire: useCallback(() => holder.acquire(store), [holder, store]),
  };
}
