// WHICH family-owned modal surfaces have the window, rather than WHETHER one does.
//
// THE DEFECT A BOOLEAN CANNOT NOT HAVE. `frame-store.ts` published one cell and every
// publisher wrote it directly, so the cell said "a card is up" and answered the
// question "is THIS card up" with whichever publisher wrote last. Two window-scoped
// overlays can be up at once — the sign-in card stays open while the palette runs the
// onboarding command — and the first of them to close published `false` underneath the
// one still open. The frame hangs `inert` on that cell, so the background came back
// reachable behind a `modal="trap-focus"` dialog: focus was still trapped, and a
// reader moving by STRUCTURE walked the rail and the whole route surface underneath a
// dialog that was still on screen. Nothing rendered differently, which is why no
// screenshot and no focus test could have caught it.
//
// SO THE REGISTER HOLDS THE CLAIMANTS AND DERIVES THE FLAG. `open` is `size > 0` and
// is never written by anyone: a publisher can only add or remove ITSELF, and the one
// arithmetic that turns a set of claims into a boolean lives here. There is no
// clear-all, deliberately — the operation the defect needed was exactly a caller
// clearing every other caller's claim, and an API that cannot express it cannot
// regress into it. A surface torn down without releasing is bounded the other way, by
// its own effect cleanup, which runs on a close and an unmount alike.
//
// RELEASE IS IDEMPOTENT AND A STALE RELEASE IS A NO-OP. React invokes an effect's
// cleanup between the two invocations strict mode makes of one effect, and a close
// followed by an unmount releases twice; both have to cost nothing rather than
// underflow a count or clear a neighbour. A `Set` of claim ids gives that for free —
// which is also why it is a set of IDS and not a counter: a counter cannot tell a
// double release from two publishers, and the double release is the common case.
//
// IT PUBLISHES THROUGH A CALLBACK AND HOLDS NO STORE. The register is what the store
// owns rather than the other way round, so this module names no store type and there
// is no edge back from `store/frame-store.ts`'s dependents into it. The comparison
// that keeps an unchanged value from re-rendering the window stays where the cell is.

/**
 * The open modal surfaces of one window, each holding its own claim.
 *
 * ONE INSTANCE PER FRAME STORE, never a module-level singleton: the fact is about a
 * WINDOW, and an auxiliary window shares no store with the main one (I-023-12).
 */
export class ModalSurfaceClaims {
  readonly #publishIsAnyHeld: (isAnyHeld: boolean) => void;
  readonly #claimants = new Set<string>();

  /**
   * @param publishIsAnyHeld receives the derived flag whenever the register moves.
   */
  public constructor(publishIsAnyHeld: (isAnyHeld: boolean) => void) {
    this.#publishIsAnyHeld = publishIsAnyHeld;
  }

  /**
   * Record that this claimant's surface has the window. Idempotent.
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
   * How many surfaces hold the window right now.
   *
   * The register's bound, observable — read by the assertion that a closed surface
   * leaves nothing behind, on `generation-latch.ts`'s `heldKeyCount` precedent.
   * Nothing on a render path reads it; the frame reads the published cell.
   */
  public get heldClaimCount(): number {
    return this.#claimants.size;
  }
}
