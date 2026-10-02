// Where a read stops, and the only place in the console that can stop one. A read has an owner
// who can leave before the answer arrives; without this the reply is still parsed and projected
// on the thread the transcript paints on, for nobody.
//
// A scope is one read line (one view's reads of one subject) and a round is one read on it. A
// round ends when a newer read supersedes it; a scope ends when its view is gone. Collapsing the
// two would leave a live view holding an aborted signal.
//
// The round is the latch claim plus the signal as one value, so a read cannot be ordered without
// being stoppable. Aborting is a synchronous flag flip; nothing awaits it, and a returning view
// gets a new scope.
//
// Only reads are cancelable. A mutation that reached the daemon has happened, a run control is a
// mutation, and a store-owned subscription or base snapshot read outlives any pane; none receives
// a signal. There is no daemon-side per-request cancel: what is canceled is the console's
// interest (the promise is dropped and the reply never parsed), since `$/subscription/cancel`
// ends a stream, not a one-shot call. This is not a scheduler (`refresh-scheduler.ts`) or a
// timeout.

import { GenerationLatch, type CurrentGenerationClaim } from "./generation-latch.js";
/** The one key every scope claims under: a scope has one round at a time. */
const READ_ROUND_KEY = "read";

/**
 * One read: whether its settlement may still install, and the signal that ends it. Both come
 * together so a caller cannot order a settlement it cannot stop. It cannot give its key back;
 * the scope does that by superseding or abandoning.
 */
export interface ReadRound extends CurrentGenerationClaim {
  /** Aborted when this round is superseded or its scope is abandoned; for reads only. */
  readonly signal: AbortSignal;
}

/**
 * How a read finished: with its answer, or with nobody left to give it to. Not a nullable value,
 * because `undefined` is a legitimate answer to several reads.
 */
export type ReadSettlement<TValue> =
  | { readonly status: "settled"; readonly value: TValue }
  | { readonly status: "abandoned" };

/**
 * One view's read line, and the two ways a read on it ends. One per subject and key, never shared
 * between owners, or either could end the other's reads.
 *
 * Terminal on `abandon`: a round opened afterwards is born aborted. `isAbandoned` lets
 * `hooks/subject-scoped/useSubjectScopedResource.ts` recognize the abandoned scope that React's
 * double-mount hands back.
 */
export class ReadScope {
  readonly #latch = new GenerationLatch();
  /** The controller of the round that is open, or of the last one that ended. */
  #controller: AbortController | undefined;
  #abandoned = false;

  /** Whether this scope is over. True once and never false again. */
  public get isAbandoned(): boolean {
    return this.#abandoned;
  }

  /**
   * Open a refresh, ending whatever refresh this scope had open. Superseding is the open itself,
   * so the line never has two refreshes in flight.
   *
   * An abandoned scope answers a round that is already over rather than refusing, so callers
   * need no "may I read" branch; the read never leaves the console because `callDaemon` checks
   * the signal before it sends.
   */
  public openRound(): ReadRound {
    if (this.#abandoned) {
      return {
        isCurrent: false,
        settle: (): boolean => false,
        signal: this.#endOpenRound(),
      };
    }
    this.#controller?.abort();
    const controller = new AbortController();
    this.#controller = controller;
    const claim = this.#latch.supersedeAndClaim(this, READ_ROUND_KEY);
    return {
      get isCurrent(): boolean {
        return claim.isCurrent;
      },
      settle: (apply: () => void): boolean => claim.settle(apply),
      signal: controller.signal,
    };
  }

  /**
   * End this line: the open round aborts, and no later round is live. Idempotent, since under a
   * double-mount React's cleanup and the holder's discard both reach it. The register is also
   * superseded because an answer already past its `await` never sees the signal move.
   */
  public abandon(): void {
    if (this.#abandoned) {
      return;
    }
    this.#abandoned = true;
    this.#endOpenRound();
    this.#latch.supersedeAll();
  }

  // One aborted signal per scope however it got there, avoiding an allocation per read on a line
  // nobody is reading.

  #endOpenRound(): AbortSignal {
    const controller = (this.#controller ??= new AbortController());
    controller.abort();
    return controller.signal;
  }
}

/**
 * Whether nobody is waiting for this read any more; the reading a caller takes after its `await`.
 *
 * A composed read (call, fold, call again) needs it between calls, since an abort landing in a
 * gap reaches no listener {@link settleUnlessAbandoned} has left attached. A function rather than
 * `signal?.aborted === true` at each site because TypeScript keeps the first narrowing of the
 * readonly `aborted` across an `await`. An absent `signal` is the mutation path, never abandoned.
 */
export function isReadAbandoned(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Settle `pending`, unless `signal` says nobody is waiting for it any more.
 *
 * It does not wait: a read that hangs would otherwise hold its caller for the life of the window
 * whatever the owner did. A rejection that arrives first travels out untouched, and one that
 * arrives after the abandonment is still handled, so it reaches no unhandled-rejection sink. No
 * `signal` is the mutation path, awaited as is.
 */
export function settleUnlessAbandoned<TValue>(
  pending: Promise<TValue>,
  signal: AbortSignal | undefined,
): Promise<ReadSettlement<TValue>> {
  if (signal === undefined) {
    return pending.then((value): ReadSettlement<TValue> => ({ status: "settled", value }));
  }
  if (signal.aborted) {
    // A dropped promise's late rejection would reach the host as an unhandled rejection, so it is
    // claimed and discarded here.
    void pending.catch(() => undefined);
    return Promise.resolve({ status: "abandoned" });
  }
  // Hand-written rather than `Promise.race`, which adds several microtask turns to every read,
  // not only abandoned ones; here `pending`'s continuation resolves the answer directly.
  return new Promise<ReadSettlement<TValue>>((resolve, reject) => {
    const onAbandoned = (): void => {
      resolve({ status: "abandoned" });
    };
    signal.addEventListener("abort", onAbandoned, { once: true });
    pending.then(
      (value) => {
        // `once` retires a listener that fired; this retires the one that did not.
        signal.removeEventListener("abort", onAbandoned);
        resolve({ status: "settled", value });
      },
      (rejection: unknown) => {
        signal.removeEventListener("abort", onAbandoned);
        // What a failed read means is `callDaemon`'s reading. If abandonment already resolved
        // this promise, rejecting is inert and the rejection is still handled here.
        reject(rejection);
      },
    );
  });
}
