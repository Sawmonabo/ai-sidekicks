/**
 * Calls a case holds open by hand, for a suite that catches a call mid-flight: to unmount under
 * it, press a control while it is outstanding, or watch what a second call does. Two shapes
 * cover the renderer's suites: a gate let through once, and a port whose every invocation waits
 * for its own answer. One home keeps their release semantics from drifting per suite.
 */

/** One call held open by hand, let through once. */
export interface ManualGate {
  /** Awaited by the port body; settles when `open` is called. */
  readonly promise: Promise<void>;
  /** Lets the held call through. */
  readonly open: () => void;
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

/** A gate a case opens once to let one held call through. */
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

/** A port body each invocation of which waits for its own answer from the case. */
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
