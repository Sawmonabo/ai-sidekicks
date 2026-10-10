// The app's system-clipboard copies whose content is not yet written, held on the bridge so a
// paste in any window waits for them and pastes what the person copied last.

/**
 * The system-clipboard copies asked for whose content is not yet written: the ones a paste in this
 * app waits for, so it pastes what the person copied last.
 */
export class PendingClipboardCopies {
  readonly #pending = new Set<Promise<void>>();

  /** Whether a copy is pending now. */
  public get isPending(): boolean {
    return this.#pending.size > 0;
  }

  /** Resolves once every copy pending now has written or given up, whichever way it went. */
  public async settled(): Promise<void> {
    await Promise.all(this.#pending);
  }

  /** Holds a copy as pending until `settlement`, which never rejects, resolves. */
  public hold(settlement: Promise<void>): void {
    this.#pending.add(settlement);
    void settlement.then(() => {
      this.#pending.delete(settlement);
    });
  }
}
