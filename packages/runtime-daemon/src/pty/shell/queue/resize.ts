// One shell's sizes on their way to the terminal host: one resize in flight at a time, and a
// backlog collapses to the newest size, so the shell is told the size a drag stopped at rather
// than every size it passed through.

/** A shell's size in character cells. */
export interface ShellSize {
  readonly columns: number;
  readonly rows: number;
}

// The newest size asked for while a resize was in flight, and everyone waiting on it.
interface PendingResize {
  size: ShellSize;
  readonly applied: PromiseWithResolvers<void>;
}

/** The sizes of one shell, applied through `resize` one at a time, newest wins. */
export class ShellResizeQueue {
  readonly #resize: (size: ShellSize) => Promise<void>;
  #isResizing = false;
  #pending: PendingResize | undefined;

  constructor(resize: (size: ShellSize) => Promise<void>) {
    this.#resize = resize;
  }

  /**
   * Asks for `size`. Resolves once the host has this size or a newer one asked for after it, and
   * rejects with the failure of the resize that would have carried it.
   */
  request(size: ShellSize): Promise<void> {
    if (this.#pending === undefined) {
      this.#pending = { size, applied: Promise.withResolvers() };
    } else {
      this.#pending.size = size;
    }
    const { promise } = this.#pending.applied;
    this.#resizeNext();
    return promise;
  }

  #resizeNext(): void {
    const next = this.#pending;
    if (this.#isResizing || next === undefined) {
      return;
    }
    this.#pending = undefined;
    this.#isResizing = true;
    // The outcome reaches every caller the resize carried, through `applied`.
    void this.#resize(next.size)
      .then(
        () => {
          next.applied.resolve();
        },
        (error: unknown) => {
          next.applied.reject(error);
        },
      )
      .finally(() => {
        this.#isResizing = false;
        this.#resizeNext();
      });
  }
}
