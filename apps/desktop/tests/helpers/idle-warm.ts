// A warm scheduler a case drives by hand: it arms nothing on its own, so the case decides when an
// idle callback runs. Shared by `components/LazyBody/idle-warm.test.ts` and the idle-warm hook
// suites.

import { type IdleWarmScheduler } from "#renderer/components/LazyBody/idle-warm.js";

/**
 * A scheduler whose steps run when the case says so. Handles are minted, not counted from the
 * pending set, so a handle stays meaningful after its step ran and a case can assert a cancel
 * released the handle the walk held.
 */
export class ManualIdleWarmScheduler implements IdleWarmScheduler {
  readonly #stepsByHandle = new Map<number, () => void>();
  #nextHandle = 1;
  /** Every handle `cancel` was called with, in order. */
  public readonly canceledHandles: number[] = [];

  public readonly schedule = (step: () => void): number => {
    const handle = this.#nextHandle;
    this.#nextHandle += 1;
    this.#stepsByHandle.set(handle, step);
    return handle;
  };

  public readonly cancel = (handle: number): void => {
    this.canceledHandles.push(handle);
    this.#stepsByHandle.delete(handle);
  };

  /** How many steps are armed and waiting. */
  public get pendingCount(): number {
    return this.#stepsByHandle.size;
  }

  /**
   * Run armed steps until nothing is armed, or until `stepLimit` have run. Bounded so a walk that
   * re-armed on a key it never cleared fails the suite instead of hanging it.
   */
  public runToQuiescence(stepLimit = 20): void {
    for (let taken = 0; taken < stepLimit && this.#stepsByHandle.size > 0; taken += 1) {
      const [handle, step] = [...this.#stepsByHandle][0] ?? [];
      if (handle === undefined || step === undefined) {
        return;
      }
      this.#stepsByHandle.delete(handle);
      step();
    }
  }
}
