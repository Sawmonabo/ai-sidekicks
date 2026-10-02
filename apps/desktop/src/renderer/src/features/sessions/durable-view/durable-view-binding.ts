// Which `UiStateStore` a durable binding is attached to. The window's store is rebuilt when the
// bridge changes, so a binding is keyed on the store's identity: the same store hands its binding
// back, a different one disposes it and mints a successor. One holder per binding kind lives at
// module scope (window scope), so a revisit never mints a second writer of one record.
// `bindingIfCurrent` mutates nothing and is what a render calls; only an effect or an event
// handler calls `acquire`, so a discarded render cannot dispose the committed tree's binding.

import type { Unsubscribe } from "@renderer/lib/emitter.js";
import type { UiStateStore } from "@renderer/store/persistence/ui-state-store.js";

/**
 * What a durable binding must offer for a holder to own its lifetime. There is no value
 * accessor: what a binding holds (a pin map) is its own vocabulary.
 */
export interface DurableViewBinding {
  /** Read the durable record once. Idempotent, so a re-acquired binding asks once. */
  hydrate(): Promise<void>;
  /** Terminal. The binding's store has been replaced and nothing more may reach it. */
  dispose(): void;
  /** Be told when the binding's value or refusal changes. */
  subscribe(sink: () => void): Unsubscribe;
}

/** What a view holds: the live binding while there is one, and the way to reach it. */
export interface DurableViewBindingAccess<TBinding extends DurableViewBinding> {
  /**
   * The binding this render may read, or `undefined` while the acquiring effect has not
   * settled. A view renders its own initial value then, which is what a fresh binding holds.
   */
  readonly binding: TBinding | undefined;
  /**
   * The binding an event handler writes through. Acquires rather than reads, because a press
   * cannot outrun a passive effect and must settle on the binding that effect acquires.
   */
  readonly acquire: () => TBinding;
}

/**
 * Which binding is live for which store, and the one disposal there is. A class with private
 * fields, because the rule below is an invariant over two fields moving together.
 */
export class DurableViewBindingHolder<TBinding extends DurableViewBinding> {
  readonly #mint: (store: UiStateStore) => TBinding;
  #store: UiStateStore | undefined;
  #binding: TBinding | undefined;

  public constructor(mint: (store: UiStateStore) => TBinding) {
    this.#mint = mint;
  }

  /**
   * The live binding for `store`, or `undefined` when this holder is on another store or has
   * not been asked yet. Pure, because a render body calls it and may run for a discarded pass.
   */
  public bindingIfCurrent(store: UiStateStore): TBinding | undefined {
    return this.#store === store ? this.#binding : undefined;
  }

  /**
   * The binding for this store, minting one on first ask and on a store change. Mutates, so
   * only effects and event handlers call it. Idempotent for one store, so strict mode's second
   * effect run does not supersede the first's binding.
   */
  public acquire(store: UiStateStore): TBinding {
    const held = this.bindingIfCurrent(store);
    if (held !== undefined) {
      return held;
    }
    // Only a different store supersedes: an unmounting component disposes nothing, so a
    // remount over the same store finds the value it left.
    this.#binding?.dispose();
    const minted = this.#mint(store);
    this.#store = store;
    this.#binding = minted;
    return minted;
  }
}

/** The unsubscribe a mount whose effect has not acquired a binding yet hands React. */
export function noDurableViewSubscription(): void {
  return undefined;
}
