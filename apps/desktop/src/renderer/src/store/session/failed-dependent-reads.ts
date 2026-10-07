// The reads a session's screen depends on beside `session.read` whose last pass failed, such as
// the repo mounts read. The catch-up line under the session header says so until that read
// itself succeeds, and its `Try again` asks each one again.
//
// Held apart from the session store's state on purpose: a read landing re-establishes that
// state, and it must not clear a failure only the failed read can clear. Each reading reports
// its own outcome here and keeps no copy, so this is the one record of the fact.

import { createStore } from "zustand/vanilla";
import type { StoreApi } from "zustand/vanilla";

import type { RefreshReason } from "#renderer/lib/reads/refresh/scheduler.js";
import { toReadableStore, type ReadableStore } from "../readable-store.js";

/** A read the session screen depends on: the one method that asks it again. */
export interface DependentRead {
  readonly requestRead: (reason: RefreshReason) => void;
}

/** Which dependent reads failed their last pass, in the order they failed. */
export interface FailedDependentReadsState {
  readonly failedReads: readonly DependentRead[];
  /**
   * How many failed passes were recorded, a repeat of a read already failed included, so a
   * retry that fails again is a new failure.
   */
  readonly failedPassCount: number;
}

/** One session's record of its dependent reads that failed, and the way to ask them again. */
export class FailedDependentReads {
  readonly #store: StoreApi<FailedDependentReadsState> = createStore<FailedDependentReadsState>(
    () => ({ failedReads: [], failedPassCount: 0 }),
  );

  /** The read-only face React subscribes to. */
  public get readable(): ReadableStore<FailedDependentReadsState> {
    return toReadableStore(this.#store);
  }

  /** Record that this read's last pass failed; a read failing again is listed once. */
  public markFailed(read: DependentRead): void {
    const { failedReads, failedPassCount } = this.#store.getState();
    this.#store.setState({
      failedReads: failedReads.includes(read) ? failedReads : [...failedReads, read],
      failedPassCount: failedPassCount + 1,
    });
  }

  /**
   * Forget this read: its pass succeeded, or the view that depended on it went away and the
   * window no longer depends on it.
   */
  public forget(read: DependentRead): void {
    const { failedReads } = this.#store.getState();
    if (!failedReads.includes(read)) {
      return;
    }
    this.#store.setState({ failedReads: failedReads.filter((failed) => failed !== read) });
  }

  /** Ask every failed read again, for a person's press on `Try again`. */
  public retryFailed(): void {
    for (const read of this.#store.getState().failedReads) {
      read.requestRead("user-request");
    }
  }
}
