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
// `frame/bindings/ui-state-lifecycle.ts` REPLACES this window's store: its effect closes the
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
// AND THE HOLDER'S OWN LIFETIME IS THE WINDOW'S, WHICH IS THE SECOND HALF OF THE
// SAME DEFECT. The holder was minted by a `useState` initializer, so it belonged to
// the COMPONENT that called this hook: leaving the sessions destination and coming
// back minted a second holder, which minted a second `SessionPinStore` over the one
// `UiStateStore` this window is on — two writers of one durable record, each holding
// its own in-memory copy of it. Nothing on screen showed it, because the mounted
// surface always read the newest of the two; what read the older one was the auto-pin
// authority stamped when a session was started, which then answered a first send with
// a switch nobody was changing any more and spread a pin map the durable record had
// moved past. So the holder is declared at MODULE scope by the module that owns the
// binding — `consoleShellPreferences` in `settings/shared/shell-preferences/` is the
// same shape for the same reason — and module scope is window scope here, since an
// auxiliary window is its own renderer process and no channel joins two windows'
// module graphs. One holder per binding kind per window, so a remount finds the
// binding it left rather than a rival for it.
//
// READING AND ACQUIRING ARE TWO METHODS, and the split is what keeps this safe under
// React: {@link DurableViewBindingHolder.bindingIfCurrent} is what a render body
// calls and mutates nothing, {@link DurableViewBindingHolder.acquire} is what an
// effect or an event handler calls and is the only place a binding is minted or
// disposed. One method doing both would let a render React discards dispose the
// binding the committed tree is subscribed to — the exact failure
// `settings/shared/shell-preferences/shell-preferences-holder.ts` records against its own first shape.

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
   * The binding this holder is holding NOW, whichever store it was minted for, or
   * `undefined` while it holds none.
   *
   * WHAT A PARTY THAT IS NOT RENDERING READS, and the difference from
   * {@link bindingIfCurrent} is that it names no store. A caller that held one would
   * be holding the store it saw when it was composed — and the auto-pin authority,
   * which is the caller this exists for, is composed when a session is STARTED and
   * consulted when a message is sent, with a navigation and a whole visit to another
   * destination in between. Handed that stale identity, {@link acquire} would dispose
   * the binding this window is actually on and mint a successor over a store the
   * window has closed, which is the very defect above with the arrow reversed.
   *
   * Pure, and never a mint: a party outside the render tree asks what this window is
   * holding and takes the answer, including the honest `undefined` that means this
   * window has no durable binding of this kind at all.
   */
  public get heldBinding(): TBinding | undefined {
    return this.#binding;
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

/**
 * Bind one durable view state to the store a surface was handed.
 *
 * THE BINDING IS ACQUIRED IN AN EFFECT AND ONLY READ DURING RENDER, which is the
 * shape every bridge-bound holder in this console already takes — see
 * `settings/shared/shell-preferences/shell-preferences-holder.ts` and `agents/run-console/agent-console-model.ts`.
 * State replaced from an effect lags its own inputs by one committed frame, and the
 * opening arm is what that frame renders.
 *
 * THE HOLDER IS THE CALLER'S AND IS THE WINDOW'S, which is why it is a parameter
 * rather than something this hook mints. A holder minted here would be one per
 * mounted component, and two mounts of one destination would then be two writers of
 * one durable record — see the header. The caller declares exactly one at module
 * scope beside the mint it is built from, and every mount of every surface that reads
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

/** The unsubscribe a mount whose effect has not acquired a binding yet hands React. */
export function noDurableViewSubscription(): void {
  return undefined;
}
