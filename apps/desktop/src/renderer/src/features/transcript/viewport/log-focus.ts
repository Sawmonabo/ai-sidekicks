// Keyboard focus on the transcript's log: put there at once while the viewport is shown, or owed
// until it is shown again, and dropped if a person put focus somewhere else meanwhile.

/** The log's keyboard focus, for one viewport, over whichever box it is attached to now. */
export class ViewportLogFocus {
  readonly #scrollContainer: () => HTMLElement | undefined;
  #isShown = true;
  /** Where focus stood when it was asked for while hidden; `undefined` when none is owed. */
  #focusOwedFrom: { readonly element: Element | null } | undefined;

  public constructor(scrollContainer: () => HTMLElement | undefined) {
    this.#scrollContainer = scrollContainer;
  }

  /**
   * Puts keyboard focus on the log. Asked while the viewport is hidden, it is owed until the
   * viewport is shown, and dropped if a person has put focus somewhere else by then.
   */
  public focusLog(): void {
    const scrollContainer = this.#scrollContainer();
    if (scrollContainer === undefined) {
      return;
    }
    if (this.#isShown) {
      scrollContainer.focus();
      return;
    }
    this.#focusOwedFrom = { element: scrollContainer.ownerDocument.activeElement };
  }

  /** Notes whether the viewport is shown, which pays a focus owed while it was hidden. */
  public noteShown(isShown: boolean): void {
    this.#isShown = isShown;
    const owed = this.#focusOwedFrom;
    const scrollContainer = this.#scrollContainer();
    if (!isShown || owed === undefined || scrollContainer === undefined) {
      return;
    }
    this.#focusOwedFrom = undefined;
    // Paid where focus still stands where it was asked from, or fell to nothing when that
    // element left, as the find field does on its close.
    const ownerDocument = scrollContainer.ownerDocument;
    const active = ownerDocument.activeElement;
    if (active === owed.element || active === null || active === ownerDocument.body) {
      scrollContainer.focus();
    }
  }
}
