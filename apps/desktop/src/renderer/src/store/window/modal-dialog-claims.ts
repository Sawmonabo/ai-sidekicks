// Which modal dialogs have the window, rather than whether one does. The register holds the
// claimants and derives the flag (`size > 0`), so with two dialogs up the first to close cannot
// publish `false` under the one still open; a dialog can only add or remove itself, and there is
// no clear-all.
//
// Release is idempotent, since strict mode's effect cleanup and a close followed by an unmount
// release twice; a `Set` of ids makes that free where a counter would underflow. It publishes
// through a callback and holds no store; the window store's cell owns the unchanged-value check.

/**
 * The open modal dialogs of one window, each holding its own claim. One instance per window
 * store, never a module-level singleton, since the fact is about one window.
 */
export class ModalDialogClaims {
  readonly #publishIsAnyHeld: (isAnyHeld: boolean) => void;
  readonly #claimants = new Set<string>();

  /** The callback receives the derived flag whenever the register moves. */
  public constructor(publishIsAnyHeld: (isAnyHeld: boolean) => void) {
    this.#publishIsAnyHeld = publishIsAnyHeld;
  }

  /**
   * Record that this claimant's dialog has the window. Idempotent, and a repeated hold publishes
   * nothing because the register did not move.
   */
  public hold(claimId: string): void {
    if (this.#claimants.has(claimId)) {
      return;
    }
    this.#claimants.add(claimId);
    this.#publishIsAnyHeld(true);
  }

  /**
   * Give up this claimant's claim and republish what the rest still say. A claim that is not held
   * is a no-op: closing one dialog says nothing about another.
   */
  public release(claimId: string): void {
    if (!this.#claimants.delete(claimId)) {
      return;
    }
    this.#publishIsAnyHeld(this.#claimants.size > 0);
  }
}
