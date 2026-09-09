// How the call door reaches the window's supervisor condition.
//
// `Spec-023 §Daemon Supervision Lifecycle` step 3 blocks mutating operations while
// the supervisor is not serving and keeps read-only subscriptions live. Enforcing
// that once at the door needs the CURRENT condition at the instant a call is put —
// not the one a component's last committed render captured — and the door is handed
// only a `ConsoleBridge`.
//
// SO THE BRIDGE CARRIES THE GATE, ON `transport/transport-reconnect.ts`' OWN
// PRECEDENT. That signal is minted by each bridge builder and reported into from
// above this family, because the observers that know the answer live where the
// window is composed. The same shape fits here for the same reason: the frame store
// is born inside `frame/composition/ConsoleFrame.tsx`, with the bridge already a
// prop, so the bridge cannot construct one — it holds the gate the frame binds its
// store into. One gate per bridge, so two windows in one process never share a
// supervisor reading only one of them was told about.
//
// AN UNBOUND GATE ANSWERS "NOTHING BLOCKS", AND THAT IS NOT FAILING OPEN. A window
// whose frame has not bound its store yet has been told nothing about the
// supervisor, and `store/shell/shell-state.ts` already has an arm for exactly that:
// `unreported`, whose block is `undefined`. The unbound answer is therefore the
// bound answer at that moment rather than a permissive stand-in for it, and it stops
// being the answer the moment a store is bound — which the frame does in the same
// hook that starts the report subscription, before any surface has mounted a control.
//
// WHY THE STORE AND NOT A COPY OF THE STATE. A gate handed a `ShellState` would hold
// a value as old as whatever published it, which is the reading `currentShellBlock`
// exists to bypass. Holding the store means every ask is a fresh read of the one
// cell that carries the condition.

import {
  currentShellMutationBlock,
  type FrameStore,
  type ShellMutationBlock,
} from "../../store/index.js";

export class ShellConditionGate {
  #frameStore: FrameStore | undefined;

  /**
   * Bind the window's frame store, so the gate answers off the live condition.
   *
   * Idempotent by assignment and re-bindable: a frame that remounts hands over its
   * new store, and the previous one is simply no longer read.
   */
  public bindFrameStore(frameStore: FrameStore): void {
    this.#frameStore = frameStore;
  }

  /**
   * Stop answering off a store this gate no longer owns.
   *
   * Called when the frame that bound the store goes away. It returns the gate to the
   * unbound reading rather than leaving it holding a store whose window is gone.
   */
  public releaseFrameStore(frameStore: FrameStore): void {
    if (this.#frameStore === frameStore) {
      this.#frameStore = undefined;
    }
  }

  /**
   * What closes a record dispatch right now, or `undefined` while nothing does.
   *
   * The block itself and not a boolean, because the door renders it: a refusal that
   * said only "blocked" would owe a second table mapping the condition to a
   * sentence, and `store/shell/shell-mutation-block.ts` already owns that one.
   *
   * METHOD-FREE, DELIBERATELY. Which methods the condition closes is the door's own
   * question and it answers it from the registry's own `kind` column, which the same
   * annotation that binds the schemas makes mandatory. A gate that also applied a rule
   * would put a second predicate on the dispatch path, and the two would then have to
   * agree about a set they both read from different families.
   */
  public currentBlock(): ShellMutationBlock | undefined {
    const frameStore = this.#frameStore;
    return frameStore === undefined ? undefined : currentShellMutationBlock(frameStore);
  }
}
