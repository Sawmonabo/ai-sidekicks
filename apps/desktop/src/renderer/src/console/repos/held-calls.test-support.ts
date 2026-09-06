/**
 * Calls a case holds open by hand.
 *
 * A suite that wants to catch a call mid-flight — to unmount under it, to press a
 * control while it is outstanding, to watch what a second call does — needs the port
 * to stop until the case says otherwise. Three shapes cover every such case in this
 * family: a gate let through once, a port whose every invocation waits for its own
 * answer, and a queue of calls released together. They live at the family root rather
 * than beside each suite because a gate re-derived per suite is a gate whose release
 * semantics drift per suite, which is what makes a held-call race hard to read.
 */

/** One call held open by hand, let through once. */
export interface ManualGate {
  /** Awaited by the port body; settles when `open` is called. */
  readonly promise: Promise<void>;
  /** Lets the held call through. */
  readonly open: () => void;
}

export function manualGate(): ManualGate {
  let release = (): void => {};
  const promise = new Promise<void>((settle) => {
    release = (): void => {
      settle();
    };
  });
  return {
    promise,
    open: (): void => {
      release();
    },
  };
}

/**
 * A port body whose every invocation is held open until the case answers it.
 *
 * Each call opens its own promise, so a case that lets one answer land and then makes
 * a second call is answering the second — not re-answering the first, which is what a
 * single shared promise would do.
 */
export interface HandAnsweredCall<TAnswer> {
  /** The port body itself: passed straight to the fixture as the port's implementation. */
  readonly invoke: () => Promise<TAnswer>;
  /** Answers the newest invocation. */
  readonly open: (answer: TAnswer) => void;
}

export function handAnsweredCall<TAnswer>(): HandAnsweredCall<TAnswer> {
  let answerNewest: (answer: TAnswer) => void = () => {};
  return {
    invoke: (): Promise<TAnswer> =>
      new Promise<TAnswer>((settle) => {
        answerNewest = settle;
      }),
    open: (answer: TAnswer): void => {
      answerNewest(answer);
    },
  };
}

/**
 * Every call parked at one interceptor, released together.
 *
 * The interceptor cannot name the calls it will park, so the case releases them as a
 * batch. Draining on release is what keeps a second `releaseAll` from letting the same
 * call through twice.
 */
export class ParkedCalls {
  readonly #letThrough: (() => void)[] = [];

  /** Awaited inside an interceptor to park the call it is handling. */
  park(): Promise<void> {
    return new Promise<void>((letThrough) => {
      this.#letThrough.push(letThrough);
    });
  }

  /** Lets every call parked so far through, and parks nothing further by itself. */
  releaseAll(): void {
    for (const letThrough of this.#letThrough.splice(0)) {
      letThrough();
    }
  }
}
