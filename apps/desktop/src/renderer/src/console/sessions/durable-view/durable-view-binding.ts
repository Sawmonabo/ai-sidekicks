// Which durable store a surface is reading from, and what happens to the one it
// replaces.
//
// `durable-view-state.ts` next door decides what a durable view value IS and what a
// refused write means. This module answers the other question: which `UiStateStore`
// a binding is attached to, and what becomes of a binding whose store has been
// replaced. They are two jobs — a state machine and a React lifetime — reviewed
// against different failures, which is the split `settings/pages/` already makes
// between its preference store and its holder.
//
// THE DEFECT THIS EXISTS FOR
//
// `frame/ui-state-lifecycle.ts` REPLACES this window's store: its effect closes the
// store it held and the next pass mints a fresh one, which is how a bridge or
// scenario change reaches storage. Both durable bindings on the sessions
// destination were built by a `useState` initializer — which runs once per mounted
// component and is never recomputed — so a replacement left them attached to the
// closed store for the rest of the mount. Three consequences, all silent: the pin
// map from the previous scenario stayed on screen, every later write went to a
// database nothing reads, and the new store was never hydrated.
//
// So the binding is keyed on the STORE's identity. A store that is still the one a
// binding was minted for hands that binding back; a different one disposes the
// binding before it and mints a successor.
//
// READING AND ACQUIRING ARE TWO METHODS, and the split is what keeps this safe under
// React: {@link DurableViewBindingHolder.bindingIfCurrent} is what a render body
// calls and mutates nothing, {@link DurableViewBindingHolder.acquire} is what an
// effect or an event handler calls and is the only place a binding is minted or
// disposed. One method doing both would let a render React discards dispose the
// binding the committed tree is subscribed to — the exact failure
// `settings/pages/shell-preferences/shell-preferences-holder.ts` records against its own first shape.

import { useCallback, useEffect, useState } from "react";

import type { Unsubscribe } from "../../core/index.js";
import type { UiStateStore } from "../../persistence/index.js";

/**
 * What a durable binding must offer for a holder to own its lifetime.
 *
 * Three verbs and no value accessor: what a binding HOLDS is its own vocabulary —
 * a pin map, a hide set — and a holder that named one would be a base class for two
 * unrelated objects rather than the one thing they share.
 */
export interface DurableViewBinding {
  /** Read the durable record once. Idempotent, so a re-acquired binding asks once. */
  hydrate(): Promise<void>;
  /** Terminal. The binding's store has been replaced and nothing more may reach it. */
  dispose(): void;
  subscribe(sink: () => void): Unsubscribe;
}

/**
 * Which binding is live for which store, and the one disposal there is.
 *
 * A class with private fields rather than a pair of refs, per `apps/desktop/AGENTS.md`:
 * the rule below is an invariant over two fields moving together, and an invariant is
 * only checkable when the state has one owner.
 */
export class DurableViewBindingHolder<TBinding extends DurableViewBinding> {
  readonly #mint: (store: UiStateStore) => TBinding;
  #store: UiStateStore | undefined;
  #binding: TBinding | undefined;

  public constructor(mint: (store: UiStateStore) => TBinding) {
    this.#mint = mint;
  }

  /**
   * The live binding for `store`, or `undefined` when this holder is on another
   * store or has not been asked for one yet.
   *
   * PURE — a field read and a comparison — because this is the call a render body
   * makes, and a render body may run for a pass React discards.
   */
  public bindingIfCurrent(store: UiStateStore): TBinding | undefined {
    return this.#store === store ? this.#binding : undefined;
  }

  /**
   * The binding for this store, minting one on first ask and on a store change.
   *
   * MUTATES, so it is reached from an effect or from an event handler and never from
   * a render body. Idempotent for one store, which is what lets strict mode invoke
   * the acquiring effect twice without the second invocation superseding what the
   * first one minted — and what lets an event handler that fires before the effect
   * has settled write into the binding that effect is about to install.
   */
  public acquire(store: UiStateStore): TBinding {
    const held = this.bindingIfCurrent(store);
    if (held !== undefined) {
      return held;
    }
    // The only disposal there is: the binding a DIFFERENT store supersedes. A
    // component unmounting disposes nothing, because a remount over the same store
    // must find the value it left rather than re-read a record it already holds.
    this.#binding?.dispose();
    const minted = this.#mint(store);
    this.#store = store;
    this.#binding = minted;
    return minted;
  }
}

/** What a surface holds: the live binding while there is one, and the way to reach it. */
export interface DurableViewBindingAccess<TBinding extends DurableViewBinding> {
  /**
   * The binding this render may read, or `undefined` while the acquiring effect has
   * not settled — the OPENING arm. A surface renders its own initial value there,
   * which is what a freshly minted binding holds anyway, so the arm costs a person
   * nothing and never shows a disposed binding's contents.
   */
  readonly binding: TBinding | undefined;
  /**
   * The binding an event handler writes through.
   *
   * Acquires rather than reads: a press must move a binding rather than be swallowed
   * by the frame before the effect ran, and a press cannot outrun a passive effect,
   * so the handler settles on the same binding that effect acquires.
   */
  readonly acquire: () => TBinding;
}

/**
 * Bind one durable view state to the store a surface was handed.
 *
 * THE BINDING IS ACQUIRED IN AN EFFECT AND ONLY READ DURING RENDER, which is the
 * shape every bridge-bound holder in this console already takes — see
 * `settings/pages/shell-preferences/shell-preferences-holder.ts` and `agents/run-console/agent-console-model.ts`.
 * State replaced from an effect lags its own inputs by one committed frame, and the
 * opening arm is what that frame renders.
 *
 * `mint` is read ONCE, by the holder's own initializer, so a caller passes a
 * module-level function rather than a closure over its props: a mint rebuilt each
 * render would be ignored, and a reader expecting otherwise would be reading a
 * binding built from the first render's values.
 */
export function useDurableViewBinding<TBinding extends DurableViewBinding>(
  store: UiStateStore,
  mint: (store: UiStateStore) => TBinding,
): DurableViewBindingAccess<TBinding> {
  const [holder] = useState(() => new DurableViewBindingHolder(mint));
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

/** The unsubscribe a mount whose effect has not acquired a binding yet hands React. */
export function noDurableViewSubscription(): void {
  return undefined;
}
