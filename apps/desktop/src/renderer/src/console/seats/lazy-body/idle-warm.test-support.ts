// A warm scheduler a case drives by hand, for the two suites that drive one.
//
// HOISTED ON THE SECOND USE, which is the package's rule: `lazy-body-warm.test.ts`
// drives the walk directly and `frame/lazy-body-warm-binding.test.tsx` drives it through
// the effect that arms it, and both need the same thing — a scheduler that arms nothing
// on its own so the case decides when an idle callback happens.
//
// It lives in `seats/` beside the scheduler interface it implements rather than in the
// frame family that also uses it: a view family may not reach another family's modules,
// and `seats/` is the lower of the two.

import { type IdleWarmScheduler } from "./lazy-body-warm.js";

/**
 * A scheduler whose steps run when the case says so.
 *
 * Handles are minted rather than counted from the pending set, so a handle stays
 * meaningful after its step has run — which is what lets a case assert that a cancel
 * released the handle the walk was actually holding.
 */
export class ManualIdleWarmScheduler implements IdleWarmScheduler {
  readonly #stepsByHandle = new Map<number, () => void>();
  #nextHandle = 1;
  /** Every handle `cancel` was called with, in order. */
  public readonly cancelledHandles: number[] = [];

  public readonly schedule = (step: () => void): number => {
    const handle = this.#nextHandle;
    this.#nextHandle += 1;
    this.#stepsByHandle.set(handle, step);
    return handle;
  };

  public readonly cancel = (handle: number): void => {
    this.cancelledHandles.push(handle);
    this.#stepsByHandle.delete(handle);
  };

  /** How many steps are armed and waiting. */
  public get pendingCount(): number {
    return this.#stepsByHandle.size;
  }

  /**
   * Run armed steps until nothing is armed, or until `stepLimit` have run.
   *
   * Bounded rather than looping to exhaustion: a walk that re-armed on a key it never
   * cleared would otherwise hang the suite instead of failing it.
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
