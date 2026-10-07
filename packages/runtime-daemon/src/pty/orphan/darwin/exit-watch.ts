// The kernel's own report of each terminal child's exit on macOS, through one kernel event queue.
// The kernel ties the watch to the process, not its id, so a reused id never fires it. One wait
// blocks off the main thread while any process is watched and none while none is; a user event on
// the same queue wakes it, so a close never hangs on a blocked wait.

import type { ProcessExitWatch } from "../operating-system.js";
import type { DarwinSystemLibrary, KernelEvent } from "./system-library.js";

// <sys/event.h>
const EVFILT_PROC = -5;
const EVFILT_USER = -10;
const EV_ADD = 0x0001;
const EV_ONESHOT = 0x0010;
const EV_CLEAR = 0x0020;
const NOTE_EXIT = 0x80000000;
const NOTE_TRIGGER = 0x01000000;
const WAKE_IDENT = 1;

/** Watches processes for their exit through a macOS kernel event queue. */
export class DarwinProcessExitWatch implements ProcessExitWatch {
  readonly #library: DarwinSystemLibrary;
  readonly #onWaitFailure: (error: Error) => void;
  readonly #queue: number;
  readonly #watched = new Map<number, () => void>();
  #pendingWait: Promise<void> | undefined;
  #isClosed = false;

  /**
   * Opens the queue. `onWaitFailure` hears a wait the system refused; exits are then seen again
   * from the next `watch()`, which starts a new wait.
   */
  constructor(library: DarwinSystemLibrary, onWaitFailure: (error: Error) => void) {
    this.#library = library;
    this.#onWaitFailure = onWaitFailure;
    this.#queue = library.openKernelQueue();
    const refusal = library.changeKernelQueue(this.#queue, {
      ...kernelEvent(WAKE_IDENT, EVFILT_USER),
      flags: EV_ADD | EV_CLEAR,
    });
    if (refusal !== undefined) {
      library.closeDescriptor(this.#queue);
      throw new Error(
        `The kernel queue refused its wake event with errno ${String(refusal.errno)}`,
      );
    }
  }

  watch(processId: number, onExit: () => void): void {
    if (this.#isClosed) {
      throw new Error("The exit watch is closed");
    }
    const refusal = this.#library.changeKernelQueue(this.#queue, {
      ...kernelEvent(processId, EVFILT_PROC),
      flags: EV_ADD | EV_ONESHOT,
      fflags: NOTE_EXIT,
    });
    if (refusal?.errno === this.#library.noSuchProcessErrno) {
      onExit();
      return;
    }
    if (refusal !== undefined) {
      throw new Error(
        `The kernel queue refused to watch process ${String(processId)} with errno ` +
          String(refusal.errno),
      );
    }
    this.#watched.set(processId, onExit);
    this.#waitWhileWatching();
  }

  async close(): Promise<void> {
    if (this.#isClosed) {
      return;
    }
    this.#isClosed = true;
    this.#watched.clear();
    if (this.#pendingWait !== undefined) {
      const refusal = this.#library.changeKernelQueue(this.#queue, {
        ...kernelEvent(WAKE_IDENT, EVFILT_USER),
        fflags: NOTE_TRIGGER,
      });
      if (refusal !== undefined) {
        throw new Error(`The kernel queue refused its wake with errno ${String(refusal.errno)}`);
      }
      await this.#pendingWait;
    }
    this.#library.closeDescriptor(this.#queue);
  }

  #waitWhileWatching(): void {
    if (this.#pendingWait !== undefined || this.#isClosed || this.#watched.size === 0) {
      return;
    }
    this.#pendingWait = new Promise((resolve) => {
      this.#library.waitForKernelEvent(this.#queue, (outcome) => {
        this.#pendingWait = undefined;
        resolve();
        if ("failure" in outcome) {
          this.#onWaitFailure(outcome.failure);
          return;
        }
        if ("errno" in outcome) {
          // A signal that interrupts the wait is no failure; the wait simply starts again.
          if (outcome.errno !== this.#library.interruptedErrno) {
            this.#onWaitFailure(
              new Error(
                `Waiting on the kernel queue for a process's exit failed with errno ` +
                  String(outcome.errno),
              ),
            );
            return;
          }
        } else if (outcome.event.filter === EVFILT_PROC) {
          const onExit = this.#watched.get(outcome.event.ident);
          this.#watched.delete(outcome.event.ident);
          onExit?.();
        }
        this.#waitWhileWatching();
      });
    });
  }
}

function kernelEvent(ident: number, filter: number): KernelEvent {
  return { ident, filter, flags: 0, fflags: 0, data: 0, udata: null };
}
