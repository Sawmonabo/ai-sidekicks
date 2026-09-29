// The sessions whose stream would not open, and what one returning edge is worth.
//
// SPLIT OUT OF `session-event-binder.ts`, WHICH OWNS WHICH SESSIONS ARE BOUND. That
// module answers for a subscription's whole life — taken on the registry's `opened`
// change, released on its `closed` one, filtered at the delivery boundary. This one
// answers a different question that had grown up inside it: which OPENS FAILED, and
// what the window does about them when the wire comes back. Two subjects, and one
// class was carrying both.
//
// WHY A FAILED OPEN HAS TO BE REMEMBERED AT ALL. A `daemon.subscribe` that throws
// leaves the session with no stream and no base state, and the registry's `opened`
// change for it has already been delivered — so nothing is going to say that session's
// name again until somebody closes and reopens it. Retaining the id is what gives the
// transport's returning edge something to re-attempt.
//
// AND THE EDGE IS NOT ONE THE RETRY'S OWN CALLER PRODUCES. The binder used to report
// the transport signal from the same open it retried, so it was both the only producer
// of the returning edge and its only consumer: a window holding ONE session whose open
// threw could never emit the edge that would retry it. The observation belongs to
// `bridge/transport/observed-subscription.ts`, which every subscription in the window
// passes through, and this class subscribes to the result rather than causing it.
//
// THE SET IS BOUNDED BY THE OPEN SET, not by a cap, which is what makes a plain `Set`
// the right holder: an id joins on a failed open and leaves on the session's close or
// on a retry that took a subscription, so nothing accumulates across a window's life.
// A retained id is also the honest reading of the state — the window holds a store for
// that session and no stream feeding it.
//
// THERE IS NO BACKOFF HERE BECAUSE THERE IS NO TIMER HERE. A retry that fails again
// reports `unreachable` through the same subscription door, which puts the signal back
// where it was: the wire is away, and the NEXT returning edge is another attempt. That
// is the whole retry ladder, and it is the signal's rather than this class's.

/**
 * What a pass needs of the binder around it, in the three questions it asks.
 *
 * Callbacks rather than a reference to the binder, so this class cannot reach a
 * subscription map, a store, or a bridge — the retained set is all it holds, and what
 * it may do about an id is exactly these three things.
 */
export interface UnboundSessionRetryOptions {
  /**
   * Whether the owner is gone. Asked BEFORE every attempt, not once per pass.
   *
   * A returning edge reaches a snapshot of the signal's sinks, so a teardown running
   * while one is being delivered leaves the rest of a pass walking against an owner
   * that holds no subscriptions and no promise to re-attempt.
   */
  readonly isRetired: () => boolean;
  /** Whether this session is still one the window holds open. */
  readonly isStillOpen: (sessionId: string) => boolean;
  /** Re-attempt one session's stream. Answers nothing: the outcome arrives as a write. */
  readonly rebind: (sessionId: string) => void;
}

export class UnboundSessionRetry {
  readonly #isRetired: () => boolean;
  readonly #isStillOpen: (sessionId: string) => boolean;
  readonly #rebind: (sessionId: string) => void;
  readonly #retainedSessionIds = new Set<string>();
  #retriedBindCount = 0;
  #passRunning = false;

  public constructor(options: UnboundSessionRetryOptions) {
    this.#isRetired = options.isRetired;
    this.#isStillOpen = options.isStillOpen;
    this.#rebind = options.rebind;
  }

  /**
   * Open sessions whose stream could not be opened, in the order they failed.
   *
   * The reading that makes a failed open observable rather than merely counted: a
   * session named here has a store the window is holding and no wire feeding it, and
   * it leaves this set on the next returning edge or when it closes.
   */
  public get retainedSessionIds(): readonly string[] {
    return [...this.#retainedSessionIds];
  }

  /**
   * Binds re-attempted on a returning edge, whether or not they took.
   *
   * Counted because the retry is correct and a window that keeps re-attempting the
   * same session on every reconnect is a wire fault upstream that only a count makes
   * visible.
   */
  public get retriedBindCount(): number {
    return this.#retriedBindCount;
  }

  /** This session's open threw. Remember it for the next returning edge. */
  public retain(sessionId: string): void {
    this.#retainedSessionIds.add(sessionId);
  }

  /**
   * Stop expecting to re-attempt this session.
   *
   * Called on a retry that took a subscription AND on a session that closed —
   * whether or not one was ever taken for it, which is what bounds the set by the
   * open set rather than by the window's life.
   */
  public forget(sessionId: string): void {
    this.#retainedSessionIds.delete(sessionId);
  }

  /** Drop every promise to re-attempt. A retired owner makes none. */
  public clear(): void {
    this.#retainedSessionIds.clear();
  }

  /**
   * Re-attempt every retained session once, on the transport's returning edge.
   *
   * A SNAPSHOT of the set is walked rather than the set itself, because a re-attempt
   * writes into it on both arms — it forgets on success and re-retains on a second
   * failure — and iterating a `Set` being written during the walk is where a re-added
   * id gets visited twice.
   *
   * AND THE PASS DOES NOT RE-ENTER ITSELF. Two retained sessions where the first open
   * fails and the second succeeds drive the signal `unreachable` and then `reachable`
   * INSIDE this walk, which is a returning edge and therefore delivers back into this
   * method mid-pass. One pass over the retained set is what a returning edge is worth,
   * so the flag turns the nested delivery into a no-op rather than a second walk that
   * re-attempts the same sessions and double-counts them; the sessions still failing
   * keep their ids and take the next real edge.
   */
  public runOnePass(): void {
    if (this.#isRetired() || this.#passRunning) {
      return;
    }
    this.#passRunning = true;
    try {
      this.#attemptEachRetainedSession();
    } finally {
      this.#passRunning = false;
    }
  }

  /**
   * One walk, discarding whatever the walk itself retired.
   *
   * A session that CLOSED since it failed is dropped without an attempt — the
   * registry's `closed` change already forgot it, and asking rather than trusting the
   * snapshot is the belt on that. And a retirement part-way through stops the walk,
   * which is what makes "a retired owner re-attempts nothing" true of the whole pass
   * rather than of its first entry, and keeps the count a count of attempts the owner
   * actually made.
   */
  #attemptEachRetainedSession(): void {
    for (const sessionId of this.retainedSessionIds) {
      if (this.#isRetired()) {
        return;
      }
      if (!this.#isStillOpen(sessionId)) {
        this.#retainedSessionIds.delete(sessionId);
        continue;
      }
      this.#retriedBindCount += 1;
      this.#rebind(sessionId);
    }
  }
}
