import { useCallback, useEffect, useState } from "react";

import type { UiStateStore } from "@renderer/store/persistence/ui-state-store.js";
import {
  type DurableViewBinding,
  type DurableViewBindingAccess,
  type DurableViewBindingHolder,
} from "../durable-view/durable-view-binding.js";

/**
 * Bind one durable view state to the store a view was handed.
 *
 * THE BINDING IS ACQUIRED IN AN EFFECT AND ONLY READ DURING RENDER, which is the
 * shape every bridge-bound holder in this console already takes — see
 * `features/settings/machine-settings/machine-settings-holder.ts` and `features/agents/pane/agents-pane-models.ts`.
 * State replaced from an effect lags its own inputs by one committed frame, and the
 * opening arm is what that frame renders.
 *
 * THE HOLDER IS THE CALLER'S AND IS THE WINDOW'S, which is why it is a parameter
 * rather than something this hook mints. A holder minted here would be one per
 * mounted component, and two mounts of one destination would then be two writers of
 * one durable record — see the header. The caller declares exactly one at module
 * scope beside the mint it is built from, and every mount of every view that reads
 * that record is handed the same one.
 */
export function useDurableViewBinding<TBinding extends DurableViewBinding>(
  holder: DurableViewBindingHolder<TBinding>,
  store: UiStateStore,
): DurableViewBindingAccess<TBinding> {
  const [acquiredBinding, setAcquiredBinding] = useState<TBinding | undefined>(() =>
    // Seeded from the pure lookup so a remount over the same store opens on the
    // binding it already holds rather than on one frame of the opening arm.
    holder.bindingIfCurrent(store),
  );

  useEffect(() => {
    const binding = holder.acquire(store);
    // The durable read rides the effect, so a render React discards performs none.
    // Idempotent per binding, so strict mode's second invocation asks nothing twice.
    void binding.hydrate();
    setAcquiredBinding(binding);
  }, [holder, store]);

  const liveBinding = holder.bindingIfCurrent(store);
  return {
    binding: acquiredBinding === liveBinding ? acquiredBinding : undefined,
    acquire: useCallback(() => holder.acquire(store), [holder, store]),
  };
}
