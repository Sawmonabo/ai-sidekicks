// One shell's flow control: the shell's read pauses only while every connection watching it has
// fallen behind, so one slow watcher never freezes a healthy one; the slow one catches up from the
// scrollback window instead. With no watchers the read never pauses, so output keeps reaching the
// scrollback window. Not gated by the control lease: it moves no bytes toward the shell.

/** The shell's PTY read, which the shell table binds to the shell's handle. */
export interface ShellFlowControlOptions {
  pause: () => Promise<void>;
  resume: () => Promise<void>;
}

/**
 * Tracks which watching connections are behind and pauses or resumes the shell's read when the
 * answer to "is every watcher behind" changes. Host calls run one at a time in the order the
 * changes happened, and each act's promise rejects when the host call it produced fails; the
 * next declaration then asks for it again.
 */
export class ShellFlowControl {
  readonly #pauseRead: () => Promise<void>;
  readonly #resumeRead: () => Promise<void>;
  // Each watching connection, true while it is behind.
  readonly #watchers = new Map<number, boolean>();
  #isReadPaused = false;
  #changeCount = 0;
  #lastHostCall: Promise<void> = Promise.resolve();

  constructor(options: ShellFlowControlOptions) {
    this.#pauseRead = options.pause;
    this.#resumeRead = options.resume;
  }

  /** Counts a connection as a watcher, caught up, resuming a read every watcher had paused. */
  addWatcher(transportId: number): Promise<void> {
    if (this.#watchers.has(transportId)) {
      return Promise.resolve();
    }
    this.#watchers.set(transportId, false);
    return this.#applyReadState();
  }

  /** Stops counting a connection as a watcher, on unsubscribe or disconnect, clearing its state. */
  removeWatcher(transportId: number): Promise<void> {
    if (!this.#watchers.delete(transportId)) {
      return Promise.resolve();
    }
    return this.#applyReadState();
  }

  /** Records whether a watching connection is behind; a connection not watching changes nothing. */
  declare(transportId: number, paused: boolean): Promise<void> {
    if (!this.#watchers.has(transportId)) {
      return Promise.resolve();
    }
    this.#watchers.set(transportId, paused);
    return this.#applyReadState();
  }

  #applyReadState(): Promise<void> {
    const shouldPause =
      this.#watchers.size > 0 && [...this.#watchers.values()].every((isBehind) => isBehind);
    if (shouldPause === this.#isReadPaused) {
      return Promise.resolve();
    }
    this.#isReadPaused = shouldPause;
    this.#changeCount += 1;
    const change = this.#changeCount;
    const hostCall = this.#lastHostCall
      .then(shouldPause ? this.#pauseRead : this.#resumeRead)
      .catch((error: unknown) => {
        // The read never changed, so it is recorded as it was and the next declaration retries,
        // unless a later change has already asked for a state of its own.
        if (this.#changeCount === change) {
          this.#isReadPaused = !shouldPause;
        }
        throw error;
      });
    // The failure reaches the act that made this change through `hostCall`; the queue only orders
    // the next call after this one, whatever its outcome.
    this.#lastHostCall = hostCall.catch(() => undefined);
    return hostCall;
  }
}
