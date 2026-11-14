// Whether entering this session has put the caret in its message box yet. Held with the session
// rather than with the composer's mount, so a session come back to, whose composer mounts again,
// does not take the caret a second time; it goes when the session's store closes.

/** The one caret a session takes on entry: the first claim wins it, every later one is refused. */
export class EntryCaret {
  #isClaimed = false;

  /** True for the first call on this session only. */
  public claim(): boolean {
    if (this.#isClaimed) {
      return false;
    }
    this.#isClaimed = true;
    return true;
  }
}
