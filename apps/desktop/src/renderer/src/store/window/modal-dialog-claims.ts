// WHICH modal dialogs have the window, rather than WHETHER one does.
//
// A single boolean every dialog wrote directly answered "is THIS dialog up" with
// whichever writer came last: two dialogs up at once, and the first to close published
// `false` underneath the one still open. The window hangs `inert` on that flag, so the
// background came back reachable by structure behind a dialog still on screen.
//
// SO THE REGISTER HOLDS THE CLAIMANTS AND DERIVES THE FLAG. `open` is `size > 0` and is
// never written by anyone: a dialog can only add or remove ITSELF. There is no clear-all,
// deliberately: the operation the defect needed was one caller clearing every other
// caller's claim, and an API that cannot express it cannot regress into it.
//
// RELEASE IS IDEMPOTENT AND A STALE RELEASE IS A NO-OP. React runs an effect's cleanup
// between the two invocations strict mode makes, and a close followed by an unmount
// releases twice; a `Set` of claim ids makes both cost nothing, which a counter could
// not.
//
// IT PUBLISHES THROUGH A CALLBACK AND HOLDS NO STORE, so this module names no store
// type. The comparison that keeps an unchanged value from re-rendering the window stays
// with the window store's cell.

/**
 * The open modal dialogs of one window, each holding its own claim.
 *
 * One instance per window store, never a module-level singleton: the fact is about one
 * window, and each window has its own store.
 */
export class ModalDialogClaims {
  readonly #publishIsAnyHeld: (isAnyHeld: boolean) => void;
  readonly #claimants = new Set<string>();

  /**
   * @param publishIsAnyHeld receives the derived flag whenever the register moves.
   */
  public constructor(publishIsAnyHeld: (isAnyHeld: boolean) => void) {
    this.#publishIsAnyHeld = publishIsAnyHeld;
  }

  /**
   * Record that this claimant's dialog has the window. Idempotent.
   *
   * A repeated hold publishes nothing at all rather than relying on the cell's own
   * comparison to absorb it: the register did not move, so there is nothing to say.
   */
  public hold(claimId: string): void {
    if (this.#claimants.has(claimId)) {
      return;
    }
    this.#claimants.add(claimId);
    this.#publishIsAnyHeld(true);
  }

  /**
   * Give up this claimant's claim, and republish what the REST of them still say.
   *
   * A claim that is not held is a no-op — nothing is published and no other claim is
   * touched. That is the whole rule the single boolean could not state: closing one
   * dialog says nothing about the other, so what goes out is the register's own
   * answer and never this caller's.
   */
  public release(claimId: string): void {
    if (!this.#claimants.delete(claimId)) {
      return;
    }
    this.#publishIsAnyHeld(this.#claimants.size > 0);
  }

  /**
   * How many dialogs hold the window right now.
   *
   * The register's bound, observable: read by the assertion that a closed dialog leaves
   * nothing behind. Nothing on a render path reads it; the window reads the published
   * cell.
   */
  public get heldClaimCount(): number {
    return this.#claimants.size;
  }
}
