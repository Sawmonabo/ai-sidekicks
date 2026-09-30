// An abandoned promise's rejection, and the claim that nothing reported it.
//
// Several cases race an outstanding operation against a bound (the frame witness, the launch
// deadline, the bounded close), and the caller's next act rejects the loser. `Promise.race`
// already keeps the loser handled by calling `then` on both promises, so the claim is asserted
// here once: the watch is installed for the tick the rejection needs and removed in a `finally`,
// so a failing case leaves no listener behind. Node raises the event to every listener, so
// vitest's own run-level report still stands behind this one.

import process from "node:process";

import { expect } from "vitest";

/** A promise held open until a case rejects it. */
export interface DeferredRejection {
  /**
   * Never settles on its own.
   *
   * Typed `Promise<never>` so one shape serves a frame source's `Promise<number>`, a close's
   * `Promise<void>` and a deadline's promise.
   */
  readonly promise: Promise<never>;
  readonly reject: (reason: Error) => void;
}

/** Creates a promise that stays pending until `reject` is called. */
export function deferredRejection(): DeferredRejection {
  let rejectPromise: (reason: Error) => void = () => {
    throw new Error("the deferred promise was rejected before its own executor ran");
  };
  const promise = new Promise<never>((_resolveNever, reject) => {
    rejectPromise = reject;
  });
  return {
    promise,
    reject: (reason: Error): void => {
      rejectPromise(reason);
    },
  };
}

/**
 * Abandons a rejection and asserts this process was never told about it.
 *
 * Waits a real 10 ms turn: Node raises `unhandledRejection` after the microtask queue empties, so
 * a synchronous assertion could pass over a rejection that was about to be reported.
 */
export async function expectNoUnhandledRejection(abandon: () => void): Promise<void> {
  const observed: unknown[] = [];
  const record = (reason: unknown): void => {
    observed.push(reason);
  };
  process.on("unhandledRejection", record);
  try {
    abandon();
    await new Promise((resolveTick) => {
      setTimeout(resolveTick, 10);
    });
    expect(
      observed,
      "an abandoned rejection reached this process unhandled, so the module under test attached no handler to it",
    ).toStrictEqual([]);
  } finally {
    process.off("unhandledRejection", record);
  }
}
