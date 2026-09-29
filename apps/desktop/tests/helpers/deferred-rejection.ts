// An abandoned promise's rejection, and the claim that nothing reported it.
//
// Three cases in this tier race an outstanding operation against a bound — the
// frame witness, the launch deadline, and the bounded close — and in every one
// the caller's next act is what rejects the loser. Each held its own copy of the
// same setup, and each ended by sleeping a tick and asserting nothing at all: the
// case could not fail on its own subject, and its own comment conceded as much —
// "this is where the process would report it". A case that cannot fail on its
// subject will be believed while that subject rots, and this one did rot: each
// module carried a bare `.catch(() => undefined)` claiming to be what kept the
// loser handled, when `Promise.race` had already done it by calling `then` on
// both promises. The lines were second handlers on already-handled promises, and
// deleting them changed nothing — which is how they were found, because the
// negative control this file exists to make possible is what asked the question.
//
// So the claim is made locally here, once, and it is a claim about the RACE: the
// watch is installed for the tick the rejection needs and removed in a `finally`,
// so a case that fails does not leave a listener reporting for the rest of the
// file. Abandon a loser outside a race and the case fails here, on its own line,
// naming its own module — with vitest's run-level report still standing behind
// it, because Node raises the event to every listener and this one is ADDED
// rather than substituted.

import process from "node:process";

import { expect } from "vitest";

/** A promise held open until a case rejects it. */
export interface DeferredRejection {
  /**
   * Never resolves, and never settles on its own.
   *
   * Typed `Promise<never>`, which is what lets one shape serve all three seams:
   * it satisfies the `Promise<number>` a frame source owes, the `Promise<void>`
   * a close owes, and whatever a deadline is asked to settle.
   */
  readonly promise: Promise<never>;
  readonly reject: (reason: Error) => void;
}

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
 * Abandon a rejection, and assert this process was never told about it.
 *
 * The turn is a real one rather than a microtask drain: Node raises
 * `unhandledRejection` after the microtask queue empties, so an assertion made
 * synchronously would pass over a rejection that was about to be reported. Ten
 * milliseconds is what the three cases already waited; what is new is that the
 * wait now ends in a claim.
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
