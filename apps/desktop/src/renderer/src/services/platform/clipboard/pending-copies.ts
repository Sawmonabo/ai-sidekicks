// The app's system-clipboard copies whose content is not yet written, held on the bridge so a
// paste in any window waits for them and pastes what the person copied last, or nothing when that
// copy failed and the clipboard still holds what came before it.

/**
 * How a pending copy ended: written, given up for a newer copy that took the clipboard, or failed,
 * leaving the clipboard as it was.
 */
export type PendingCopyOutcome = "written" | "given-up" | "failed";

/**
 * The system-clipboard copies asked for whose content is not yet written: the ones a paste in this
 * app waits for, so it pastes what the person copied last.
 */
export class PendingClipboardCopies {
  readonly #pending = new Set<Promise<PendingCopyOutcome>>();

  /** Whether a copy is pending now. */
  public get isPending(): boolean {
    return this.#pending.size > 0;
  }

  /**
   * Resolves once every copy pending now has written or given up, whichever way it went, with how
   * the one asked for last ended.
   */
  public async settled(): Promise<PendingCopyOutcome | undefined> {
    const outcomes = await Promise.all(this.#pending);
    return outcomes.at(-1);
  }

  /** Holds a copy as pending until `outcome`, which never rejects, resolves. */
  public hold(outcome: Promise<PendingCopyOutcome>): void {
    this.#pending.add(outcome);
    void outcome.then(() => {
      this.#pending.delete(outcome);
    });
  }
}
